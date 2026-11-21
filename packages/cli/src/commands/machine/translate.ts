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
  GT_SETUP_URL,
  MachineTranslateError,
  resolveMachineTranslateProvider,
} from "./providers/resolveProvider.js";
import type { AnyMachineTranslateProvider } from "./providers/types.js";
import { isInteractive } from "../cloud/index.js";

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
  .option(
    "--no-browser",
    "Sign in to General Translation with a code instead of a browser on this machine.",
  )
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
 * Translates and writes the translation files after each translated locale,
 * but only if something was translated: saving still rewrites settings.json,
 * and plugins that don't keep unchanged entries reformat their files, which
 * must not change files in git. Reports success only once the files are
 * written.
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
  const { translated, bundles } = await translateCommandAction({
    ...args,
    save,
  });
  if (translated === 0 && bundles > 0) {
    log.info("No translations were added, so no files were changed.");
  }
  if (bundles > 0) log.success("Machine translate complete.");
}

/**
 * Translates missing translations into the project. Returns how many were
 * added.
 *
 * Translates one target locale at a time and calls `save` after each locale
 * that got translations, so a run that is stopped keeps the locales it
 * finished.
 *
 * When a translation fails, it still adds those that came back, so that the
 * next run doesn't pay for them again, and throws a `MachineTranslateError`
 * with their number. A bundle gets a new message only with all its
 * translations: half a plural would match nothing. A translation that came back empty or
 * with a placeholder dropped or changed isn't added (see
 * `planBundleTranslation`), and the run throws too. A failure of the provider
 * (not of a text) stops the run after its locale is saved. A save that fails
 * after a translation failed or was rejected says so too.
 */
/**
 * Whether sign-in uses a code instead of a browser: as asked with
 * `--no-browser`, or where no browser can be shown, as the cloud command
 * decides (CI, pipes, and Linux without a display, as in SSH and containers).
 */
export function signInWithCode(args: {
  browser: boolean;
  isTTY: boolean;
  env: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
}): boolean {
  return !args.browser || !isInteractive(args);
}

export async function translateCommandAction(args: {
  project: InlangProject;
  provider?: AnyMachineTranslateProvider;
  /** Writes the project's files; called after each translated locale. */
  save?: () => Promise<void>;
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
      const plans: Array<{ id: string; plan: BundleTranslationPlan }> = [];
      const errors: string[] = [];
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
        plans.push({ id: bundle.id, plan });
      }
      return {
        plans,
        errors,
        missing: plans.flatMap(({ plan }) => plan.missing),
      };
    };

    // Planned as if the provider uses context, as the default one does.
    // Without context, a plural that needs forms the source lacks gets only
    // the source's forms instead of being expanded, and the only forms added
    // beyond the expanded ones are ones the target never selects. So with
    // nothing missing there is nothing worth translating and no provider is
    // resolved: the run doesn't ask to sign in or fail for want of a key.
    let planned = planBundles(true);
    const provider =
      planned.missing.length === 0
        ? undefined
        : (args.provider ??
          (await resolveMachineTranslateProvider({
            env: process.env,
            projectPath: options.project,
            settings,
            // SSH terminals can use the printed sign-in URL without a display.
            interactive: Boolean(
              process.stdin.isTTY && process.stdout.isTTY && !process.env.CI,
            ),
            noBrowser: signInWithCode({
              browser: options.browser,
              isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
              env: process.env,
            }),
          })));
    if (provider && !provider.supportsContext) planned = planBundles(false);
    const { plans, missing } = planned;
    if (planned.errors.length > 0) {
      log.warn("Some bundles could not be translated.");
      log.warn(planned.errors.join("\n"));
    }
    /** the locales a new message was created in, by plan */
    const created = new Map<BundleTranslationPlan, Set<string>>();
    // a provider with context writes every form, unless the selectors differ
    // or the target has a select value the source lacks
    const warnPlurals = () =>
      warnAboutPlurals(
        plans,
        created,
        !provider || provider.supportsContext === true,
      );
    // A provider without context finds nothing when only plural forms it
    // can't add are missing.
    if (!provider || missing.length === 0) {
      warnPlurals();
      return { translated: 0, bundles: bundles.length };
    }
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
    /** why translations were rejected, by bundle id, by locale */
    const rejected = new Map<string, Map<string, Set<string>>>();
    const errors = new Set<string>();
    let translated = 0;
    /** why translation stopped so far, without what was saved */
    const failureLines = () => [
      ...errors,
      ...(rejected.size > 0
        ? [
            "Some translations weren't saved: they came back empty, or their placeholders don't match the source's:",
            ...[...rejected].map(
              ([locale, byId]) =>
                `  ${locale}: ${[...byId].map(([id, reasons]) => `${id} (${[...reasons].join(", ")})`).join(", ")}`,
            ),
          ]
        : []),
    ];
    // One locale at a time, saved when it is done: a run that is stopped,
    // or whose provider fails, keeps every locale it finished.
    try {
      for (const locale of new Set(missing.map((t) => t.targetLocale))) {
        const result = await translateMissing({
          provider,
          sourceLocale: settings.baseLocale,
          missing: missing.filter((t) => t.targetLocale === locale),
          onProgress: (count) => bar?.increment(count),
        });
        if (!result.ok) errors.add(result.error);

        let translatedInLocale = 0;
        for (const { plan } of plans) {
          const ofLocale = plan.missing.filter(
            (t) => t.targetLocale === locale,
          );
          const returned = ofLocale.filter((t) => result.translations.has(t));
          // a new message gets the locale only with all its translations
          if (
            returned.length === 0 ||
            (returned.length < ofLocale.length && plan.newLocales.has(locale))
          ) {
            continue;
          }
          const bundle = plan.apply(
            new Map(returned.map((t) => [t, result.translations.get(t)!])),
          );
          translatedInLocale += returned.length;
          // before the write: a failed write still reports the plurals. A
          // rejected translation drops a new message (see `apply`).
          if (plan.newLocales.has(locale) && bundle.rejected.length === 0) {
            created.set(plan, (created.get(plan) ?? new Set()).add(locale));
          }
          // only this locale's message: a later locale's write would otherwise
          // put back the messages of the bundle as planned
          await upsertBundleNested(args.project.db, {
            ...bundle.data,
            messages: bundle.data.messages.filter(
              (message) => message.locale === locale,
            ),
          });
          // variants that got a new id to keep the order of the source
          // message; deleted after the write, so that nothing is lost if it
          // fails
          if (bundle.replacedVariantIds?.length) {
            await args.project.db
              .deleteFrom("inlang_variant")
              .where("id", "in", bundle.replacedVariantIds)
              .execute();
          }
          for (const { reasons } of bundle.rejected) {
            const byId = rejected.get(locale) ?? new Map<string, Set<string>>();
            const bundleReasons = byId.get(bundle.data.id!) ?? new Set();
            for (const reason of reasons) bundleReasons.add(reason);
            rejected.set(locale, byId.set(bundle.data.id!, bundleReasons));
            translatedInLocale--;
          }
        }
        translated += translatedInLocale;
        if (translatedInLocale > 0) {
          await args.save?.().catch((saveError: Error) => {
            // a failed save mustn't hide why translation stopped
            const lines = failureLines();
            throw lines.length > 0
              ? new MachineTranslateError(
                  [...lines, saveError.message].join("\n"),
                )
              : saveError;
          });
        }
        // a provider failure: the locales after this one would fail too
        if (!result.ok && result.scope === "provider") break;
      }
    } finally {
      bar?.stop();
      // However the run ends, so that a failed write doesn't lose them.
      warnPlurals();
    }

    const lines = failureLines();
    if (lines.length > 0) {
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

/**
 * Warns about the plurals of each bundle (see `PluralReport`), but not about a
 * new message that wasn't created, because one of its translations failed or
 * was rejected, or its locale wasn't reached: the next run translates it
 * whole.
 */
function warnAboutPlurals(
  plans: Array<{ id: string; plan: BundleTranslationPlan }>,
  created: Map<BundleTranslationPlan, Set<string>>,
  supportsContext: boolean,
): void {
  const reported = (plan: BundleTranslationPlan, locale: string) =>
    !plan.newLocales.has(locale) || Boolean(created.get(plan)?.has(locale));
  /** bundle ids and the plural categories they lack, by locale */
  const incomplete = new Map<
    string,
    { ids: string[]; categories: Set<string> }
  >();
  /** bundle ids whose message has other selectors than the source's, by locale */
  const differentSelectors = new Map<string, string[]>();
  const unknownPluralRules = new Set<string>();
  for (const { id, plan } of plans) {
    for (const { locale, categories } of plan.incompletePlurals) {
      if (!reported(plan, locale)) continue;
      const entry = incomplete.get(locale) ?? {
        ids: [],
        categories: new Set(),
      };
      entry.ids.push(id);
      for (const category of categories) entry.categories.add(category);
      incomplete.set(locale, entry);
    }
    for (const locale of plan.differentSelectors) {
      differentSelectors.set(locale, [
        ...(differentSelectors.get(locale) ?? []),
        id,
      ]);
    }
    for (const locale of plan.unknownPluralRules) {
      if (reported(plan, locale)) unknownPluralRules.add(locale);
    }
  }

  if (incomplete.size > 0) {
    log.warn(
      [
        "Some plurals lack forms their language needs; add them by hand:",
        ...[...incomplete].map(
          ([locale, { ids, categories }]) =>
            `  ${locale} (${[...categories].join(", ")}): ${shortList(ids)}`,
        ),
        "Until then, whether those numbers fall back to another form depends on the message format: i18next, for example, shows the message key.",
        ...(supportsContext
          ? []
          : [
              `General Translation writes every form a language needs: ${GT_SETUP_URL}`,
            ]),
      ].join("\n"),
    );
  }
  if (differentSelectors.size > 0) {
    log.warn(
      [
        "Some translations choose their forms by other selectors than the source, such as none or no exact number, so the source's forms can't be added to them; translate them by hand:",
        ...[...differentSelectors].map(
          ([locale, ids]) => `  ${locale}: ${shortList(ids)}`,
        ),
      ].join("\n"),
    );
  }
  if (unknownPluralRules.size > 0) {
    log.warn(
      `Plural rules unknown for ${[...unknownPluralRules].join(", ")}; copied the source's forms.`,
    );
  }
}

/** The first ids, and how many more there are: a project can have thousands. */
function shortList(ids: string[], shown = 5): string {
  return ids.length <= shown
    ? ids.join(", ")
    : `${ids.slice(0, shown).join(", ")}, … and ${ids.length - shown} more`;
}
