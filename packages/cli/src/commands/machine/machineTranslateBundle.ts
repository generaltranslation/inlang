// uuid v7: variants are ordered by id, so the translated variants keep the
// order of the source message
import { v7 as randomUUID } from "uuid";
import {
  isPluralSelector,
  matchValue,
  missingVariants,
  selectorGroups,
  variantCovers,
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
  BatchMachineTranslateProvider,
  TranslateFailure,
} from "./providers/types.js";

/**
 * Texts per batch request. Keeps request bodies small while a large project
 * needs only a few requests per locale.
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
type MissingTranslation = {
  sourceVariant: VariantRow;
  targetLocale: string;
  /** The source pattern, serialized for the provider. */
  text: string;
  /** The bundle description, if any. */
  context?: string;
};

/** CLDR plural categories, in CLDR order. */
export const PLURAL_CATEGORIES = ["zero", "one", "two", "few", "many", "other"];

/** What a bundle's plurals tell the user. */
export type PluralReport = {
  /**
   * Target locales left out, with the plural categories they need that no
   * source variant has: translating the source's forms would leave the
   * translation without them, so they are left to be added by hand.
   */
  skippedPlurals: Array<{ locale: string; categories: string[] }>;
  /**
   * Target locales translated without known plural rules (see the SDK's
   * `pluralRules`): their plural forms are the source's.
   */
  unknownPluralRules: string[];
  /**
   * Selectors that aren't plurals but whose keys are all plural categories:
   * they never match a number, the source likely lacks `: plural`.
   */
  categoryKeySelectors: string[];
};

/**
 * The translations a bundle is missing, and how to add them to it once they
 * are translated.
 */
export type BundleTranslationPlan = PluralReport & {
  missing: MissingTranslation[];
  /** Adds a translation for each of `missing` to a copy of the bundle. */
  apply: (
    translations: Map<MissingTranslation, VariantRow["pattern"]>,
  ) => TranslatedBundle;
};

type TranslatedBundle = {
  data: NewBundleNested;
  /**
   * Ids of variants of `bundle` that `data` has with a new id, to take the
   * order of the source message (see `orderLikeSource`). Delete them after
   * writing `data`.
   */
  replacedVariantIds?: string[];
};

/**
 * Finds the translations the bundle is missing in the target locales: no
 * variant for a source variant, or an empty one.
 *
 * A target locale that lacks a form in a plural category no source variant
 * has (Russian `few` and `many` for an English `one` and `*`) is left out,
 * see `PluralReport`: this run translates only the source's forms. Forms the
 * source lacks in its own locale too don't count: the translation is as
 * complete as the source.
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

  const { declarations } = args.bundle;
  const sourceMissing = missingVariants(sourceMessage, declarations);
  const missing: MissingTranslation[] = [];
  const report: PluralReport = {
    skippedPlurals: [],
    unknownPluralRules: [],
    categoryKeySelectors: sourceMessage.selectors
      .map(({ name }) => name)
      .filter((name) => {
        const keys = sourceMessage.variants
          .map((variant) => matchValue(variant, name))
          .filter((key) => key !== "*");
        return (
          !isPluralSelector(name, declarations) &&
          keys.length > 0 &&
          keys.every((key) => PLURAL_CATEGORIES.includes(key))
        );
      }),
  };

  // a locale given twice is translated once
  for (const targetLocale of new Set(args.targetLocales)) {
    if (targetLocale === args.sourceLocale) {
      continue;
    }

    const targetMessage = args.bundle.messages.find(
      (message) => message.locale === targetLocale,
    );
    const target = {
      locale: targetLocale,
      selectors: targetMessage?.selectors ?? sourceMessage.selectors,
      variants: targetMessage?.variants ?? [],
    };
    const categories = new Set(
      missingVariants(target, declarations, {
        referenceVariants: sourceMessage.variants,
      })
        .filter(
          (matches) =>
            !sourceMissing.some((sourceMatches) =>
              variantCovers({ matches: sourceMatches }, matches, declarations),
            ),
        )
        .flatMap((matches) =>
          newCategories(matches, sourceMessage.variants, declarations),
        ),
    );
    if (categories.size > 0) {
      report.skippedPlurals.push({
        locale: targetLocale,
        categories: [...categories],
      });
      continue;
    }

    const translated = missing.length;
    for (const sourceVariant of sourceMessage.variants) {
      const existingVariant = findMatchingVariant(
        target.variants,
        sourceVariant.matches,
      );

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
        text: serializePattern(sourceVariant.pattern, {}),
        context: args.bundle.description || undefined,
      });
    }
    if (
      missing.length > translated &&
      hasUnknownPluralRules(target, declarations)
    ) {
      report.unknownPluralRules.push(targetLocale);
    }
  }

  return {
    ...report,
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
        const pattern = translations.get(translation)!;
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
 * The plural categories a missing form needs that no source variant of its
 * branch has: Russian `few` × `female` when no English variant is `few` and
 * `female`. A branch is the form's values of the other selectors (gender,
 * the plural's type, an exact number), or their catch-all where the source
 * has no variant for a value, as at runtime. So English ordinal `few` is no
 * source for Russian cardinal `few`, and a gender only the translation has
 * needs no category the source has.
 */
function newCategories(
  matches: VariantRow["matches"],
  sourceVariants: VariantRow[],
  declarations: BundleNested["declarations"],
): string[] {
  const valueOf = (match: VariantRow["matches"][number]) =>
    match.type === "literal-match" ? match.value : "*";
  const branch = sourceVariants.filter((variant) =>
    matches.every((match) => {
      if (isPluralSelector(match.key, declarations)) return true;
      const value = matchValue(variant, match.key);
      return (
        value === valueOf(match) ||
        (value === "*" &&
          !sourceVariants.some(
            (other) => matchValue(other, match.key) === valueOf(match),
          ))
      );
    }),
  );
  return matches.flatMap((match) =>
    match.type === "literal-match" &&
    isPluralSelector(match.key, declarations) &&
    !branch.some((variant) => matchValue(variant, match.key) === match.value)
      ? [match.value]
      : [],
  );
}

/**
 * True when a plural of the message has no known rules in its locale, so the
 * SDK requires only its catch-all: an unknown locale, or options only known
 * at runtime. A plural whose `type` a select chooses (`type=$pluralType`)
 * has rules per type, known when the locale is.
 */
function hasUnknownPluralRules(
  message: Parameters<typeof selectorGroups>[0],
  declarations: BundleNested["declarations"],
): boolean {
  return selectorGroups(message, declarations).some(
    (group) =>
      group.isPlural &&
      (group.typeSelector ? !knowsPluralRules(message.locale) : !group.plural),
  );
}

/** Whether `Intl` has plural rules for a locale, written as the SDK reads it. */
function knowsPluralRules(locale: string): boolean {
  try {
    return (
      Intl.PluralRules.supportedLocalesOf(locale.replace(/_/g, "-")).length > 0
    );
  } catch {
    // not a valid locale, e.g. `x-foo`
    return false;
  }
}

/**
 * Translates the missing translations with at most `MAX_CONCURRENT_REQUESTS`
 * requests in flight. A batch provider gets the texts of each target locale in
 * requests of at most `MAX_TEXTS_PER_REQUEST`; a single-text provider gets
 * one request per text.
 *
 * Stops starting requests at the first failure, returned or thrown, and
 * returns it once the requests in flight have settled.
 */
export async function translateMissing(args: {
  provider: AnyMachineTranslateProvider;
  sourceLocale: string;
  missing: MissingTranslation[];
  /** Called with the number of texts each successful request translated. */
  onProgress?: (translated: number) => void;
}): Promise<
  | { ok: true; translations: Map<MissingTranslation, VariantRow["pattern"]> }
  | TranslateFailure
> {
  const { provider, sourceLocale } = args;
  const batched = "translateBatch" in provider;
  // a single-text provider gets batches of one text, so that both kinds of
  // provider share the scheduling and the checks of the results below
  const translateBatch: BatchMachineTranslateProvider["translateBatch"] =
    batched
      ? (batch) => provider.translateBatch(batch)
      : async ({ texts, ...locales }) => {
          const [key, { text, context }] = Object.entries(texts)[0]!;
          const result = await provider.translateText({
            text,
            ...locales,
            ...(context ? { context } : {}),
          });
          return result.ok
            ? { ok: true, translatedTexts: { [key]: result.translatedText } }
            : result;
        };
  const textsPerRequest = batched ? MAX_TEXTS_PER_REQUEST : 1;

  const byLocale = new Map<string, MissingTranslation[]>();
  for (const translation of args.missing) {
    const missing = byLocale.get(translation.targetLocale) ?? [];
    missing.push(translation);
    byLocale.set(translation.targetLocale, missing);
  }

  const translations = new Map<MissingTranslation, VariantRow["pattern"]>();
  /** Each sends one request and records what it translated. */
  const requests: Array<() => Promise<{ ok: true } | TranslateFailure>> = [];
  for (const [targetLocale, missing] of byLocale) {
    for (let start = 0; start < missing.length; start += textsPerRequest) {
      const chunk = missing.slice(start, start + textsPerRequest);
      requests.push(async () => {
        // keyed by position, not by source variant id, so that one source
        // variant can have several translations into a locale (e.g. one per
        // plural form of the target language), each with its own context
        const result = await translateBatch({
          sourceLocale,
          targetLocale,
          texts: Object.fromEntries(
            chunk.map(({ text, context }, index) => [
              String(index),
              { text, context },
            ]),
          ),
        });
        if (!result.ok) return result;
        for (const [index, translation] of chunk.entries()) {
          const text = result.translatedTexts[String(index)];
          if (text === undefined) {
            return {
              ok: false,
              error: `No translation was returned for "${translation.text}".`,
            };
          }
          translations.set(translation, deserializePattern(text));
        }
        args.onProgress?.(chunk.length);
        return result;
      });
    }
  }

  let failure: TranslateFailure | undefined;
  let next = 0;
  const worker = async () => {
    while (!failure && next < requests.length) {
      // e.g. a network error, or a translation that isn't a valid pattern
      const result = await requests[next++]!().catch(
        (error): TranslateFailure => ({ ok: false, error: String(error) }),
      );
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
