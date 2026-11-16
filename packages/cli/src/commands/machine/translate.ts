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
  PLURAL_CATEGORIES,
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
 * Thrown when a translation failed, before anything was written. The message
 * is for the user as is.
 */
export class MachineTranslateError extends Error {
  override name = "MachineTranslateError";
}

/**
 * Translates and writes the translation files, but only if something was
 * translated: saving still rewrites settings.json, and plugins that don't
 * keep unchanged entries reformat their files, which must not change files
 * in git.
 */
export async function translateAndSave(args: {
  project: InlangProject;
  path: string;
}) {
  const { translated, bundles } = await translateCommandAction(args);
  if (translated > 0) {
    await saveProjectToDirectory({
      fs,
      path: args.path,
      project: args.project,
    });
  } else if (bundles > 0) {
    log.info("No translations were added, so no files were changed.");
  }
}

/**
 * Translates missing translations into the project. Returns how many were
 * added.
 *
 * Writes nothing unless every translation succeeded, so a failed run leaves
 * the project as it was.
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
    /** bundle ids by locale */
    const skipped = new Map<string, string[]>();
    const skippedCategories = new Set<string>();
    const unknownPluralRules = new Set<string>();
    const categoryKeySelectors: string[] = [];
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
      for (const { locale, categories } of plan.skippedPlurals) {
        skipped.set(locale, [...(skipped.get(locale) ?? []), bundle.id]);
        for (const category of categories) skippedCategories.add(category);
      }
      for (const locale of plan.unknownPluralRules) {
        unknownPluralRules.add(locale);
      }
      if (plan.categoryKeySelectors.length > 0) {
        categoryKeySelectors.push(
          `  ${bundle.id}: ${plan.categoryKeySelectors.join(", ")}`,
        );
      }
      // Unchanged bundles aren't written back.
      if (plan.missing.length > 0) plans.push(plan);
    }
    if (errors.length > 0) {
      log.warn("Some bundles could not be translated.");
      log.warn(errors.join("\n"));
    }
    if (categoryKeySelectors.length > 0) {
      log.warn(
        [
          `These selectors have plural categories as keys but aren't plurals, so their keys never match a number. Declare them with ": plural".`,
          ...categoryKeySelectors,
        ].join("\n"),
      );
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

    if (!result.ok) throw new MachineTranslateError(result.error);

    for (const plan of plans) {
      const bundle = plan.apply(result.translations);
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
    }

    if (skipped.size > 0) {
      const count = [...skipped.values()].flat().length;
      log.warn(
        [
          `Skipped ${count} ${count === 1 ? "message" : "messages"} in ${[...skipped.keys()].join(", ")}: their plurals need forms the source doesn't have (${PLURAL_CATEGORIES.filter((category) => skippedCategories.has(category)).join(", ")}). Add them by hand, then run again.`,
          ...[...skipped].map(
            ([locale, ids]) => `  ${locale}: ${ids.join(", ")}`,
          ),
        ].join("\n"),
      );
    }
    for (const locale of unknownPluralRules) {
      log.warn(
        `Plural rules unknown for ${locale}; copied the source's forms.`,
      );
    }
    log.success("Machine translate complete.");
    return { translated: missing.length, bundles: bundles.length };
  } catch (error) {
    bar?.stop();
    throw error;
  }
}
