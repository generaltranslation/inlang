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
import {
  MachineTranslateError,
  resolveMachineTranslateProvider,
} from "./providers/resolveProvider.js";
import { isInteractive } from "../cloud/index.js";
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
 * the project as it was. A translation that dropped or changed a placeholder
 * isn't added (see `planBundleTranslation`) and is reported.
 */
export async function translateCommandAction(args: {
  project: InlangProject;
  provider?: AnyMachineTranslateProvider;
}): Promise<{ translated: number; bundles: number }> {
  const options = translate.opts();

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

    const planBundles = (supportsContext: boolean) => {
      const plans: BundleTranslationPlan[] = [];
      const errors: string[] = [];
      /** bundle ids and the plural categories they need, by locale */
      const skipped = new Map<
        string,
        { ids: string[]; categories: Set<string> }
      >();
      const unknownPluralRules = new Set<string>();
      for (const bundle of bundles) {
        const plan = planBundleTranslation({
          bundle,
          sourceLocale: settings.baseLocale,
          targetLocales,
          supportsContext,
        });
        if ("error" in plan) {
          errors.push(plan.error);
          continue;
        }
        for (const { locale, categories } of plan.skippedPlurals) {
          const entry = skipped.get(locale) ?? {
            ids: [],
            categories: new Set(),
          };
          entry.ids.push(bundle.id);
          for (const category of categories) entry.categories.add(category);
          skipped.set(locale, entry);
        }
        for (const locale of plan.unknownPluralRules) {
          unknownPluralRules.add(locale);
        }
        // Unchanged bundles aren't written back.
        if (plan.missing.length > 0) plans.push(plan);
      }
      const warnings: string[] = [];
      if (errors.length > 0) {
        warnings.push(
          "Some bundles could not be translated.",
          errors.join("\n"),
        );
      }
      if (skipped.size > 0) {
        warnings.push(
          [
            "Some messages were skipped: their plurals need forms the source doesn't have. Add them by hand, then run again.",
            ...[...skipped].map(
              ([locale, { ids, categories }]) =>
                `  ${locale} (${[...categories].join(", ")}): ${ids.join(", ")}`,
            ),
          ].join("\n"),
        );
      }
      if (unknownPluralRules.size > 0) {
        warnings.push(
          `Plural rules unknown for ${[...unknownPluralRules].join(", ")}; copied the source's forms.`,
        );
      }
      return {
        plans,
        missing: plans.flatMap((plan) => plan.missing),
        warnings,
      };
    };

    // Planned as if the provider uses context, as the default one does.
    // Without context, a plural that needs forms the source lacks is skipped
    // instead of expanded, and the only forms added beyond these are ones the
    // target never selects. So with nothing missing there is nothing worth
    // translating and no provider is resolved: the run doesn't ask to sign
    // in or fail for want of a key.
    let planned = planBundles(true);
    if (planned.missing.length === 0) {
      for (const warning of planned.warnings) log.warn(warning);
      log.success("Machine translate complete.");
      return { translated: 0, bundles: bundles.length };
    }

    const provider =
      args.provider ??
      (await resolveMachineTranslateProvider({
        env: process.env,
        projectPath: options.project,
        settings,
        interactive: isInteractive({
          // The sign-in prompt reads stdin.
          isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
          env: process.env,
        }),
      }));
    if (!provider.supportsContext) planned = planBundles(false);
    const { plans, missing } = planned;
    for (const warning of planned.warnings) log.warn(warning);
    if (
      !provider.supportsContext &&
      bundles.some(
        (bundle: { description?: string | null }) => bundle.description,
      )
    ) {
      log.warn(
        "The selected translation provider doesn't use bundle descriptions as context.",
      );
    }

    bar?.start(missing.length, 0);
    const result = await translateMissing({
      provider,
      sourceLocale: settings.baseLocale,
      missing,
      onProgress: (translated) => bar?.increment(translated),
    });
    bar?.stop();

    if (!result.ok) throw new MachineTranslateError(result.error);

    /** bundle ids with reverted translations, by locale */
    const revertedIds = new Map<string, Set<string>>();
    const revertedPlaceholders = new Set<string>();
    let revertedCount = 0;
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
      for (const { locale, placeholders } of bundle.reverted) {
        revertedIds.set(
          locale,
          (revertedIds.get(locale) ?? new Set()).add(bundle.data.id!),
        );
        for (const placeholder of placeholders) {
          revertedPlaceholders.add(placeholder);
        }
        revertedCount++;
      }
    }
    if (revertedCount > 0) {
      log.warn(
        [
          `Some translations were reverted: they dropped or changed a placeholder (${[...revertedPlaceholders].join(", ")}). Translate them by hand, or run again.`,
          ...[...revertedIds].map(
            ([locale, ids]) => `  ${locale}: ${[...ids].join(", ")}`,
          ),
        ].join("\n"),
      );
    }
    log.success("Machine translate complete.");
    return {
      translated: missing.length - revertedCount,
      bundles: bundles.length,
    };
  } catch (error) {
    bar?.stop();
    throw error;
  }
}
