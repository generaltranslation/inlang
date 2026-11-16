// uuid v7: variants are ordered by id, so the translated variants keep the
// order of the source message
import { v7 as randomUUID } from "uuid";
import {
  checkBundle,
  isPluralSelector,
  markupNames,
  matchValue,
  missingVariants,
  pluralRules,
  resolveAnnotation,
  selectorGroups,
  variableNames,
  variantCovers,
  Text,
  type BundleNested,
  type Declaration,
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

/** What a bundle's plurals tell the user. */
type PluralReport = {
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
};

/**
 * The translations a bundle is missing, and how to add them to it once they
 * are translated.
 */
export type BundleTranslationPlan = PluralReport & {
  missing: MissingTranslation[];
  /**
   * Adds a translation for each of `missing` to a copy of the bundle, except
   * those that dropped or changed a placeholder (see `brokenPlaceholders`),
   * and a new message whose catch-all is one of them.
   */
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
  /**
   * Translations left out because they dropped or changed a variable or
   * markup of the source, with those placeholders (`{count}`, `<b>`), and
   * the other translations of a new message whose catch-all was one of them.
   */
  reverted: Array<{ locale: string; placeholders: string[] }>;
};

/**
 * Finds the translations the bundle is missing in the target locales: no
 * variant for a source variant, or an empty one.
 * Skips target locales whose plurals need categories the source lacks, see
 * `PluralReport`.
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
  let sourceMissing: ReturnType<typeof missingVariants> | undefined;
  const missing: MissingTranslation[] = [];
  const report: PluralReport = {
    skippedPlurals: [],
    unknownPluralRules: [],
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
    const categories = new Set<string>();
    // The forms are the target's, so without a plural in the target no
    // category can be missing. `missingVariants` takes seconds on a message
    // with several selects, so it isn't called then.
    if (
      target.selectors.some(({ name }) => isPluralSelector(name, declarations))
    ) {
      const lackedBySource = (sourceMissing ??= missingVariants(
        sourceMessage,
        declarations,
      ));
      // an empty form is missing, like one the target doesn't have
      missingVariants(target, declarations, {
        variants: target.variants.filter((variant) => !isEmpty(variant)),
        referenceVariants: sourceMessage.variants,
      })
        .filter(
          (matches) =>
            !lackedBySource.some((sourceMatches) =>
              variantCovers({ matches: sourceMatches }, matches, declarations),
            ),
        )
        .flatMap((matches) =>
          newCategories(matches, sourceMessage.variants, declarations),
        )
        .forEach((category) => categories.add(category));
    }
    if (categories.size > 0) {
      report.skippedPlurals.push({
        locale: targetLocale,
        categories: [...categories],
      });
      continue;
    }

    const missingBefore = missing.length;
    for (const sourceVariant of sourceMessage.variants) {
      const existingVariant = findMatchingVariant({
        variants: target.variants,
        matches: sourceVariant.matches,
        sourceVariants: sourceMessage.variants,
        declarations,
      });

      if (existingVariant && !isEmpty(existingVariant)) {
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
      missing.length > missingBefore &&
      hasUnknownPluralRules(target, declarations)
    ) {
      report.unknownPluralRules.push(targetLocale);
    }
  }

  /**
   * Adds `translations` to a copy of the bundle, except those in `skip`, and
   * returns the variants it wrote by id.
   */
  const write = (
    translations: Map<MissingTranslation, VariantRow["pattern"]>,
    skip?: Set<MissingTranslation>,
  ) => {
    const copy = structuredClone(args.bundle);
    const sourceMessage = copy.messages.find(
      (message) => message.locale === args.sourceLocale,
    )!;
    /** variants added to messages that existed, by message */
    const addedVariants = new Map<
      BundleNested["messages"][number],
      Set<VariantRow>
    >();
    const written = new Map<VariantRow, MissingTranslation>();

    for (const translation of missing) {
      if (skip?.has(translation)) continue;
      const pattern = translations.get(translation)!;
      const { sourceVariant, targetLocale } = translation;
      const targetMessage = copy.messages.find(
        (message) => message.locale === targetLocale,
      );

      if (targetMessage) {
        const existingVariant = findMatchingVariant({
          variants: targetMessage.variants,
          matches: sourceVariant.matches,
          sourceVariants: sourceMessage.variants,
          declarations: copy.declarations,
        });

        // only an empty variant is missing a translation
        if (existingVariant) {
          existingVariant.pattern = pattern;
          written.set(existingVariant, translation);
        } else {
          const variant = {
            id: randomUUID(),
            message_id: targetMessage.id,
            matches: sourceVariant.matches,
            pattern,
          } satisfies VariantRow;
          targetMessage.variants.push(variant);
          written.set(variant, translation);
          const added = addedVariants.get(targetMessage) ?? new Set();
          added.add(variant);
          addedVariants.set(targetMessage, added);
        }
      } else {
        const newMessageId = randomUUID();
        const variant = {
          id: randomUUID(),
          message_id: newMessageId,
          matches: sourceVariant.matches,
          pattern,
        } satisfies VariantRow;
        copy.messages.push({
          ...sourceMessage,
          id: newMessageId,
          locale: targetLocale,
          variants: [variant],
        });
        written.set(variant, translation);
      }
    }

    const replacedVariantIds: string[] = [];
    for (const [message, added] of addedVariants) {
      replacedVariantIds.push(
        ...orderLikeSource(
          message,
          sourceMessage.variants,
          added,
          copy.declarations,
        ),
      );
    }
    return {
      bundle:
        replacedVariantIds.length > 0
          ? { data: copy, replacedVariantIds }
          : { data: copy },
      // by id once ordered: ordering gives variants new ids
      written: new Map(
        [...written].map(([variant, translation]) => [variant.id, translation]),
      ),
    };
  };

  return {
    ...report,
    missing,
    apply: (translations) => {
      const first = write(translations);
      const broken = brokenPlaceholders({
        bundle: first.bundle.data,
        translated: first.written,
        locales: args.targetLocales,
        referenceLocale: args.sourceLocale,
      });
      // a new message without its catch-all (`*`, or a plural's `other`)
      // shows the bundle id for what no other form matches, worse than no
      // message, for which the runtime falls back to another locale
      const brokenNewMessages = new Set(
        [...broken.keys()]
          .map((id) => first.written.get(id)!)
          .filter(
            ({ sourceVariant, targetLocale }) =>
              sourceVariant.matches.every(
                (match) =>
                  match.type === "catchall-match" || match.value === "other",
              ) &&
              !args.bundle.messages.some(
                (message) => message.locale === targetLocale,
              ),
          )
          .map(({ targetLocale }) => targetLocale),
      );
      const reverted = [...first.written].filter(
        ([id, translation]) =>
          broken.has(id) || brokenNewMessages.has(translation.targetLocale),
      );
      if (reverted.length === 0) {
        return { ...first.bundle, reverted: [] };
      }
      // checks are per variant, so leaving a translation out changes no
      // other's
      const second = write(
        translations,
        new Set(reverted.map(([, translation]) => translation)),
      );
      return {
        ...second.bundle,
        reverted: reverted.map(([id, translation]) => ({
          locale: translation.targetLocale,
          placeholders: broken.get(id) ?? [],
        })),
      };
    },
  };
}

/**
 * The placeholders (`{count}`, `<b>`) that translated variants dropped or
 * changed, by variant id. The provider gets them as `notranslate` spans and
 * may translate or lose one, so the variant would print a wrong or no value.
 *
 * An issue counts only if the source form doesn't share it: the checks are
 * per variant and see its pattern only through its names, so hand-written
 * content and what the source lacks itself (an English `one` without
 * `{count}`, for French `one`, 0 and 1) revert nothing. The SDK compares by
 * plural form: a German `one` may spell out its number.
 */
function brokenPlaceholders(args: {
  bundle: BundleNested;
  /** variant ids, with the translation each holds */
  translated: Map<string, MissingTranslation>;
  locales: string[];
  referenceLocale: string;
}): Map<string, string[]> {
  const broken = new Map<string, string[]>();
  for (const diagnostic of checkBundle({
    bundle: args.bundle,
    locales: args.locales,
    referenceLocale: args.referenceLocale,
    checks: ["missing-variable", "unknown-variable", "missing-markup"],
  })) {
    if (!("variantId" in diagnostic && "name" in diagnostic)) continue;
    const translation = args.translated.get(diagnostic.variantId);
    if (!translation) continue;
    const markup = diagnostic.checkId === "missing-markup";
    const inSource = (markup ? markupNames : variableNames)(
      translation.sourceVariant.pattern,
    ).includes(diagnostic.name);
    if (inSource === (diagnostic.checkId === "unknown-variable")) continue;
    broken.set(diagnostic.variantId, [
      ...(broken.get(diagnostic.variantId) ?? []),
      markup ? `<${diagnostic.name}>` : `{${diagnostic.name}}`,
    ]);
  }
  return broken;
}

/** True when a variant has no text: its translation is missing. */
function isEmpty(variant: VariantRow): boolean {
  return (
    variant.pattern.length === 0 ||
    (variant.pattern.length === 1 &&
      variant.pattern[0]?.type === "text" &&
      (variant.pattern[0] as Text).value === "")
  );
}

/**
 * The plural categories a missing form needs that no source variant of its
 * branch has. A branch is the form's values of the other selectors, or their
 * catch-all where the source has no variant for a value, as at runtime: so
 * English ordinal `few` is no source for Russian cardinal `few`.
 */
function newCategories(
  matches: VariantRow["matches"],
  sourceVariants: VariantRow[],
  declarations: BundleNested["declarations"],
): string[] {
  const branch = sourceVariants.filter((variant) =>
    matches.every((match) => {
      if (isPluralSelector(match.key, declarations)) return true;
      const wanted = matchValue({ matches }, match.key);
      const value = matchValue(variant, match.key);
      return (
        value === wanted ||
        (value === "*" &&
          !sourceVariants.some(
            (other) => matchValue(other, match.key) === wanted,
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
 * True when a plural of the message has no known rules in its locale (an
 * unknown locale, or options only known at runtime), so the SDK requires only
 * its catch-all. A plural whose `type` a select chooses has known rules when
 * its cardinal rules are known.
 */
function hasUnknownPluralRules(
  message: Parameters<typeof selectorGroups>[0],
  declarations: BundleNested["declarations"],
): boolean {
  return selectorGroups(message, declarations).some((group) => {
    if (!group.isPlural) return false;
    if (!group.typeSelector) return !group.plural;
    const annotation = resolveAnnotation(group.selector, declarations)!;
    const cardinal: Declaration = {
      type: "input-variable",
      name: group.selector,
      annotation: {
        ...annotation,
        options: annotation.options.filter((option) => option.name !== "type"),
      },
    };
    return !pluralRules(group.selector, [cardinal], message.locale);
  });
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
  declarations: BundleNested["declarations"],
): string[] {
  const sourceIndex = (variant: VariantRow) =>
    sourceVariants.findIndex(
      (source) =>
        findMatchingVariant({
          variants: [variant],
          matches: source.matches,
          sourceVariants,
          declarations,
        }) !== undefined,
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
