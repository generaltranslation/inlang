// uuid v7: variants are ordered by id, so the translated variants keep the
// order of the source message
import { v7 as randomUUID } from "uuid";
import {
  Text,
  type BundleNested,
  type NewBundleNested,
  type VariantRow,
} from "@inlang/sdk";
import {
  deserializePattern,
  findMatchingVariant,
  serializePattern,
} from "./patternSerialization.js";
import type {
  AnyMachineTranslateProvider,
  TranslateFailure,
} from "./providers/types.js";

/**
 * Texts per batch request. The batch API documents no limit but rejects
 * bodies that are too large; 50 messages stay far below that, while a project
 * with hundreds of messages still needs only a few requests per locale.
 */
const MAX_TEXTS_PER_REQUEST = 50;

/**
 * Requests in flight at once, for every provider. Sending every request at
 * once runs into the providers' rate limits on large projects.
 */
const MAX_CONCURRENT_REQUESTS = 4;

type MachineTranslateArgs = {
  bundle: BundleNested;
  sourceLocale: string;
  targetLocales: string[];
};

/** A translation that a bundle is missing. */
export type MissingTranslation = {
  sourceVariant: VariantRow;
  targetLocale: string;
  /** The source pattern, serialized for the provider. */
  text: string;
  /** The bundle description, if any. */
  context?: string;
};

/**
 * The translations a bundle is missing, and how to add them to it once they
 * are translated.
 */
export type BundleTranslationPlan = {
  missing: MissingTranslation[];
  /** Adds a translation for each of `missing` to a copy of the bundle. */
  apply: (
    translations: Map<MissingTranslation, string>,
  ) => MachineTranslateResult & { data: NewBundleNested };
};

export type MachineTranslateResult = {
  data?: NewBundleNested;
  error?: string;
  /**
   * Ids of variants of `bundle` that `data` has with a new id, to take the
   * order of the source message (see `orderLikeSource`). Delete them after
   * writing `data`.
   */
  replacedVariantIds?: string[];
};

/**
 * Machine translates the given bundle using the configured translation provider.
 *
 * The translation updates or creates variants only for missing translations in
 * the requested target locales. Existing non-empty variants are preserved.
 *
 * @example
 *   const provider = resolveMachineTranslateProvider();
 *   const result = await machineTranslateBundle({
 *     bundle,
 *     sourceLocale: "en",
 *     targetLocales: ["de"],
 *     provider,
 *   });
 *   if (result.data) {
 *     await upsertBundleNested(project, result.data);
 *   }
 */
export async function machineTranslateBundle(
  args: MachineTranslateArgs & { provider: AnyMachineTranslateProvider },
): Promise<MachineTranslateResult> {
  try {
    const plan = planBundleTranslation(args);
    if ("error" in plan) {
      return plan;
    }
    const result = await translateMissing({
      provider: args.provider,
      sourceLocale: args.sourceLocale,
      missing: plan.missing,
    });
    if (!result.ok) {
      return { error: result.error };
    }
    return plan.apply(result.translations);
  } catch (error) {
    return { error: error?.toString() ?? "unknown error" };
  }
}

/**
 * Finds the translations the bundle is missing in the target locales: no
 * variant for a source variant, or an empty one.
 */
export function planBundleTranslation(
  args: MachineTranslateArgs,
): BundleTranslationPlan | { error: string } {
  const sourceMessage = args.bundle.messages.find(
    (message) => message.locale === args.sourceLocale,
  );

  if (!sourceMessage) {
    return {
      error: `Source locale not found in the bundle: ${args.bundle.id}`,
    };
  }

  const missing: MissingTranslation[] = [];
  for (const sourceVariant of sourceMessage.variants) {
    const text = serializePattern(sourceVariant.pattern, {});

    for (const targetLocale of args.targetLocales) {
      if (targetLocale === args.sourceLocale) {
        continue;
      }

      const targetMessage = args.bundle.messages.find(
        (message) => message.locale === targetLocale,
      );
      const existingVariant =
        targetMessage &&
        findMatchingVariant(targetMessage.variants, sourceVariant.matches);

      if (
        existingVariant &&
        !(
          existingVariant.pattern.length === 0 ||
          (existingVariant.pattern.length === 1 &&
            existingVariant.pattern[0]?.type === "text" &&
            (existingVariant.pattern[0] as Text).value === "")
        )
      ) {
        continue;
      }

      missing.push({
        sourceVariant,
        targetLocale,
        text,
        context: args.bundle.description || undefined,
      });
    }
  }

  return {
    missing,
    apply: (translations) => {
      const copy = structuredClone(args.bundle);
      const sourceMessage = copy.messages.find(
        (message) => message.locale === args.sourceLocale,
      )!;
      /** variants added to messages that existed, by message */
      const addedVariants = new Map<
        BundleNested["messages"][number],
        Set<VariantRow>
      >();

      for (const translation of missing) {
        const pattern = deserializePattern(translations.get(translation)!);
        const { sourceVariant, targetLocale } = translation;
        const targetMessage = copy.messages.find(
          (message) => message.locale === targetLocale,
        );

        if (targetMessage) {
          const existingVariant = findMatchingVariant(
            targetMessage.variants,
            sourceVariant.matches,
          );

          // only an empty variant is missing a translation
          if (existingVariant) {
            existingVariant.pattern = pattern;
          } else {
            const variant = {
              id: randomUUID(),
              message_id: targetMessage.id,
              matches: sourceVariant.matches,
              pattern,
            } satisfies VariantRow;
            targetMessage.variants.push(variant);
            const added = addedVariants.get(targetMessage) ?? new Set();
            added.add(variant);
            addedVariants.set(targetMessage, added);
          }
        } else {
          const newMessageId = randomUUID();
          copy.messages.push({
            ...sourceMessage,
            id: newMessageId,
            locale: targetLocale,
            variants: [
              {
                id: randomUUID(),
                message_id: newMessageId,
                matches: sourceVariant.matches,
                pattern,
              } satisfies VariantRow,
            ],
          });
        }
      }

      const replacedVariantIds: string[] = [];
      for (const [message, added] of addedVariants) {
        replacedVariantIds.push(
          ...orderLikeSource(message, sourceMessage.variants, added),
        );
      }
      return replacedVariantIds.length > 0
        ? { data: copy, replacedVariantIds }
        : { data: copy };
    },
  };
}

/**
 * Translates the missing translations with at most `MAX_CONCURRENT_REQUESTS`
 * requests in flight. A batch provider gets the texts of each target locale in
 * requests of at most `MAX_TEXTS_PER_REQUEST`, keyed by source variant id.
 *
 * Stops starting requests at the first failure and returns it once the
 * requests in flight have settled.
 */
export async function translateMissing(args: {
  provider: AnyMachineTranslateProvider;
  sourceLocale: string;
  missing: MissingTranslation[];
  /** Called with the number of texts each successful request translated. */
  onProgress?: (translated: number) => void;
}): Promise<
  { ok: true; translations: Map<MissingTranslation, string> } | TranslateFailure
> {
  const { provider, sourceLocale } = args;
  const translations = new Map<MissingTranslation, string>();
  /** Each sends one request and records what it translated. */
  const requests: Array<() => Promise<{ ok: true } | TranslateFailure>> = [];

  if ("translateBatch" in provider) {
    const byLocale = new Map<string, MissingTranslation[]>();
    for (const translation of args.missing) {
      const missing = byLocale.get(translation.targetLocale) ?? [];
      missing.push(translation);
      byLocale.set(translation.targetLocale, missing);
    }
    for (const [targetLocale, missing] of byLocale) {
      for (
        let start = 0;
        start < missing.length;
        start += MAX_TEXTS_PER_REQUEST
      ) {
        const chunk = missing.slice(start, start + MAX_TEXTS_PER_REQUEST);
        requests.push(async () => {
          const result = await provider.translateBatch({
            sourceLocale,
            targetLocale,
            texts: Object.fromEntries(
              chunk.map(({ sourceVariant, text, context }) => [
                sourceVariant.id,
                { text, context },
              ]),
            ),
          });
          if (result.ok) {
            for (const translation of chunk) {
              translations.set(
                translation,
                result.translatedTexts[translation.sourceVariant.id]!,
              );
            }
            args.onProgress?.(chunk.length);
          }
          return result;
        });
      }
    }
  } else {
    for (const translation of args.missing) {
      const { text, targetLocale, context } = translation;
      requests.push(async () => {
        const result = await provider.translateText({
          text,
          sourceLocale,
          targetLocale,
          ...(context ? { context } : {}),
        });
        if (result.ok) {
          translations.set(translation, result.translatedText);
          args.onProgress?.(1);
        }
        return result;
      });
    }
  }

  let failure: TranslateFailure | undefined;
  let next = 0;
  const worker = async () => {
    while (!failure && next < requests.length) {
      const result = await requests[next++]!();
      if (!result.ok) failure ??= result;
    }
  };
  await Promise.all(
    Array.from({ length: MAX_CONCURRENT_REQUESTS }, () => worker()),
  );
  return failure ?? { ok: true, translations };
}

const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Puts the variants of a message that existed in the order of the source
 * message, after `added` were appended to it.
 *
 * Runtimes like Paraglide JS select the first variant that matches, so a
 * translated `one` must not end up after an existing catch-all. Variants are
 * ordered by id (uuid v7) in the project, so the variants from the first one
 * whose place changes on get new ids in the new order; the ids they had are
 * returned, to be deleted. Existing variants keep their matches and pattern,
 * and are put in the order of the source too.
 * A variant the source doesn't have (e.g. a plural category of the target
 * language) stays after the variant it followed. Messages whose order doesn't
 * change keep every id.
 */
export function orderLikeSource(
  message: { variants: VariantRow[] },
  sourceVariants: VariantRow[],
  added: Set<VariantRow>,
): string[] {
  const sourceIndex = (variant: VariantRow) =>
    sourceVariants.findIndex(
      (source) => findMatchingVariant([variant], source.matches) !== undefined,
    );
  let previous = -1;
  const keyed = message.variants.map((variant, position) => {
    let key = sourceIndex(variant);
    if (key === -1) key = previous;
    if (!added.has(variant)) previous = key;
    return { variant, key, position };
  });
  const ordered = [...keyed]
    .sort((a, b) => a.key - b.key || a.position - b.position)
    .map(({ variant }) => variant);
  // the first variant whose place changes, or whose id doesn't sort after
  // the variant before it (e.g. an added variant after a non-v7 id)
  let start = ordered.findIndex(
    (variant, index) =>
      variant !== message.variants[index] ||
      (index > 0 && !(ordered[index - 1]!.id < variant.id)),
  );
  if (start === -1) return [];
  // the variants before keep their ids: a new id must sort after them
  const newId = randomUUID();
  while (
    start > 0 &&
    !(UUID_V7.test(ordered[start - 1]!.id) && ordered[start - 1]!.id < newId)
  ) {
    start--;
  }
  const replaced: string[] = [];
  for (const variant of ordered.slice(start)) {
    if (!added.has(variant)) replaced.push(variant.id);
    variant.id = randomUUID();
  }
  message.variants = ordered;
  return replaced;
}
