/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { Command } from "commander";
import { getInlangProject } from "../../utilities/getInlangProject.js";
import { log, logError } from "../../utilities/log.js";
import {
  saveProjectToDirectory,
  selectBundleNested,
  upsertBundleNested,
  type InlangProject,
} from "@inlang/sdk";
import { projectOption } from "../../utilities/globalFlags.js";
import progessBar from "cli-progress";
import fs from "node:fs/promises";
import {
  planBundleTranslation,
  translateMissing,
  type BundleTranslationPlan,
} from "./machineTranslateBundle.js";
import { resolveMachineTranslateProvider } from "./providers/resolveProvider.js";
import type { AnyMachineTranslateProvider } from "./providers/types.js";

export const translate = new Command()
  .command("translate")
  .requiredOption(projectOption.flags, projectOption.description)
  .option("-q, --quiet", "don't log every tranlation.", false)
  .option("--locale <source>", "Locales for translation.")
  .option(
    "--targetLocales <targets...>",
    "Comma separated list of target locales for translation.",
  )
  .option("-n, --nobar", "disable progress bar", false)
  .description("Machine translate bundles.")
  .action(async (args: { force: boolean; project: string }) => {
    let exitCode = 0;
    try {
      const project = await getInlangProject({ projectPath: args.project });
      await translateAndSave({ project, path: args.project });
    } catch (error) {
      if (error instanceof MachineTranslateError) log.error(error.message);
      else logError(error);
      exitCode = 1;
    } finally {
      process.exit(exitCode);
    }
  });

/**
 * Thrown when a translation failed or was rejected. The message is for the
 * user as is. `translated` translations came back intact and were added to
 * the project.
 */
export class MachineTranslateError extends Error {
  override name = "MachineTranslateError";
  constructor(
    message: string,
    readonly translated = 0,
  ) {
    super(message);
  }
}

/**
 * Translates and writes the translation files, but only if something was
 * translated: saving still rewrites settings.json, and plugins that don't
 * keep unchanged entries reformat their files, which must not change files
 * in git. Reports success only once the files are written.
 */
export async function translateAndSave(args: {
  project: InlangProject;
  path: string;
}) {
  const save = () =>
    saveProjectToDirectory({
      fs,
      path: args.path,
      project: args.project,
    }).catch((error: unknown) => {
      // as a message: a plugin's stack trace can hold its whole source
      throw new MachineTranslateError(
        `The translations couldn't be saved: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  const { translated, bundles } = await translateCommandAction(args).catch(
    async (error) => {
      if (error instanceof MachineTranslateError && error.translated > 0) {
        await save();
      }
      throw error;
    },
  );
  if (translated > 0) {
    await save();
  } else if (bundles > 0) {
    log.info("No translations were added, so no files were changed.");
  }
  if (bundles > 0) log.success("Machine translate complete.");
}

/**
 * Translates missing translations into the project. Returns how many were
 * added.
 *
 * When a translation fails, it still adds those that came back, so that the
 * next run doesn't pay for them again, and throws a `MachineTranslateError`
 * with their number. A bundle gets a locale only with all its translations:
 * half a plural would match nothing. A translation that came back empty or
 * with a placeholder dropped or changed isn't added (see
 * `planBundleTranslation`), and the run throws too.
 */
export async function translateCommandAction(args: {
  project: InlangProject;
  provider?: AnyMachineTranslateProvider;
}): Promise<{ translated: number; bundles: number }> {
  const options = translate.opts();
  const provider = args.provider ?? resolveMachineTranslateProvider();

  const bar = options.nobar
    ? undefined
    : new progessBar.SingleBar(
        {
          clearOnComplete: true,
          format: `🤖 Machine translating | {bar} | {percentage}% | {value}/{total} Translations`,
        },
        progessBar.Presets.shades_grey,
      );
  try {
    const settings = await args.project.settings.get();

    const targetLocales: string[] = options.targetLocales
      ? options.targetLocales[0]?.split(",")
      : settings.locales;

    const bundles = await selectBundleNested(args.project.db)
      .selectAll()
      .execute();

    if (bundles.length === 0) {
      log.warn(
        "No message bundles found to translate. Check your project setup with `inlang check`",
      );
      return { translated: 0, bundles: 0 };
    }

    if (
      !provider.supportsContext &&
      bundles.some(
        (bundle: { description?: string | null }) => bundle.description,
      )
    ) {
      log.warn(
        "The selected translation provider does not use bundle descriptions. Use OpenAI or DeepL to translate with context.",
      );
    }

    const plans: BundleTranslationPlan[] = [];
    const errors: string[] = [];
    /** bundle ids and the plural categories they lack, by locale */
    const incomplete = new Map<
      string,
      { ids: string[]; categories: Set<string> }
    >();
    const unknownPluralRules = new Set<string>();
    for (const bundle of bundles) {
      const plan = planBundleTranslation({
        bundle,
        sourceLocale: settings.baseLocale,
        targetLocales,
      });
      if ("error" in plan) {
        errors.push(plan.error);
        continue;
      }
      for (const { locale, categories } of plan.incompletePlurals) {
        const entry = incomplete.get(locale) ?? {
          ids: [],
          categories: new Set(),
        };
        entry.ids.push(bundle.id);
        for (const category of categories) entry.categories.add(category);
        incomplete.set(locale, entry);
      }
      for (const locale of plan.unknownPluralRules) {
        unknownPluralRules.add(locale);
      }
      // Unchanged bundles aren't written back.
      if (plan.missing.length > 0) plans.push(plan);
    }
    if (errors.length > 0) {
      log.warn("Some bundles could not be translated.");
      log.warn(errors.join("\n"));
    }
    const missing = plans.flatMap((plan) => plan.missing);

    bar?.start(missing.length, 0);
    const result = await translateMissing({
      provider,
      sourceLocale: settings.baseLocale,
      missing,
      onProgress: (translated) => bar?.increment(translated),
    });
    bar?.stop();

    /** why translations were rejected, by bundle id, by locale */
    const rejected = new Map<string, Map<string, Set<string>>>();
    let translated = 0;
    for (const plan of plans) {
      const failedLocales = new Set(
        plan.missing
          .filter((translation) => !result.translations.has(translation))
          .map((translation) => translation.targetLocale),
      );
      const translations = new Map(
        plan.missing
          .filter((translation) => !failedLocales.has(translation.targetLocale))
          .map((translation) => [
            translation,
            result.translations.get(translation)!,
          ]),
      );
      if (translations.size === 0) continue;
      translated += translations.size;
      const bundle = plan.apply(translations);
      await upsertBundleNested(args.project.db, bundle.data);
      // variants that got a new id to keep the order of the source
      // message; deleted after the write, so that nothing is lost if it
      // fails
      if (bundle.replacedVariantIds?.length) {
        await args.project.db
          .deleteFrom("inlang_variant")
          .where("id", "in", bundle.replacedVariantIds)
          .execute();
      }
      for (const { locale, reasons } of bundle.rejected) {
        const byId = rejected.get(locale) ?? new Map<string, Set<string>>();
        const bundleReasons = byId.get(bundle.data.id!) ?? new Set();
        for (const reason of reasons) bundleReasons.add(reason);
        rejected.set(locale, byId.set(bundle.data.id!, bundleReasons));
        translated--;
      }
    }

    if (incomplete.size > 0) {
      log.warn(
        [
          "Some plurals lack forms their language needs. Until those forms are added by hand, their numbers show the catch-all form:",
          ...[...incomplete].map(
            ([locale, { ids, categories }]) =>
              `  ${locale} (${[...categories].join(", ")}): ${ids.join(", ")}`,
          ),
        ].join("\n"),
      );
    }
    if (unknownPluralRules.size > 0) {
      log.warn(
        `Plural rules unknown for ${[...unknownPluralRules].join(", ")}; copied the source's forms.`,
      );
    }
    if (!result.ok || rejected.size > 0) {
      const lines = result.ok ? [] : [result.error];
      if (rejected.size > 0) {
        lines.push(
          "Some translations weren't saved: they came back empty, or their placeholders don't match the source's:",
          ...[...rejected].map(
            ([locale, byId]) =>
              `  ${locale}: ${[...byId].map(([id, reasons]) => `${id} (${[...reasons].join(", ")})`).join(", ")}`,
          ),
        );
      }
      if (translated > 0) {
        lines.push(
          `Saved the ${translated} ${translated === 1 ? "translation" : "translations"} that came back${rejected.size > 0 ? " intact" : ""}. Run again to translate the rest.`,
        );
      }
      throw new MachineTranslateError(lines.join("\n"), translated);
    }
    return { translated, bundles: bundles.length };
  } catch (error) {
    bar?.stop();
    throw error;
  }
}
