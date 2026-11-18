// uuid v7: variants are ordered by id, so the translated variants keep the
// order of the source message
import { isDeepStrictEqual } from "node:util";
import { v7 as randomUUID } from "uuid";
import {
  isEmptyPattern,
  isPluralSelector,
  matchValue,
  missingVariants,
  pluralExamples,
  pluralRules,
  requiredVariants,
  selectorGroups,
  sourceVariantFor,
  variantCovers,
  type BundleNested,
  type MarkupEnd,
  type MarkupStart,
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
  /** The variant the translation is translated from. */
  sourceVariant: VariantRow;
  /** The matches of the translated variant: the form of the target. */
  matches: VariantRow["matches"];
  targetLocale: string;
  /** The source pattern, serialized for the provider. */
  text: string;
  /** The bundle description, and the plural form if it isn't the source's. */
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
   * Adds the translation of each of `missing` that `translations` has to a
   * copy of the bundle, except those it rejects (see `rejectionReasons`),
   * and every translation of a new message that has one of them.
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
   * Translations left out, with why (see `rejectionReasons`), and the other
   * translations of a new message that has one of them, with no reason of
   * their own.
   */
  rejected: Array<{ locale: string; reasons: string[] }>;
};

/**
 * Finds the translations the bundle is missing in the target locales: no
 * variant for a source variant, or an empty one.
 * With a provider that uses context, a target with the source's selectors
 * gets every plural form its language needs instead, see `missingForms`.
 * Otherwise skips target locales whose plurals need categories the source
 * lacks, see `PluralReport`.
 */
export function planBundleTranslation(
  args: MachineTranslateArgs & {
    /** Whether the provider uses context, which plural expansion needs. */
    supportsContext?: boolean;
  },
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
  /** locales with a message before the run: a new one is written in order */
  const existingLocales = new Set(
    args.bundle.messages.map((message) => message.locale),
  );
  /** the target's forms, by locale, for the locales `missingForms` planned */
  const formsByLocale = new Map<string, VariantRow["matches"][]>();
  const sourceSelectors = sourceMessage.selectors.map(({ name }) => name);
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
    // without a plural only the source's forms are needed (no cross product
    // of the selects), and no category can be missing
    const hasPlural = target.selectors.some(({ name }) =>
      isPluralSelector(name, declarations),
    );
    // without known rules only the catch-all is needed: the source's forms
    // are copied instead
    let unknownRules = hasUnknownPluralRules(target, declarations);
    const forms =
      args.supportsContext &&
      hasPlural &&
      !unknownRules &&
      // `orderLikeSource` puts an added form before a later form the source
      // has, which only the source's selectors guarantee
      target.selectors.map(({ name }) => name).join() === sourceSelectors.join()
        ? requiredVariants(target, declarations, {
            referenceVariants: sourceMessage.variants,
          })
        : undefined;
    // The SDK plans plural types as i18next lays them out, with cardinal
    // categories under the catch-all type. A source form in a branch the plan
    // lacks, such as `pluralType=cardinal` with its own categories, would be
    // dropped, so the source's forms are copied instead.
    if (forms && dropsSourceBranch(sourceMessage, forms, declarations))
      unknownRules = true;
    else if (forms) {
      formsByLocale.set(targetLocale, forms);
      missing.push(
        ...missingForms({
          target,
          forms,
          sourceMessage,
          sourceLocale: args.sourceLocale,
          declarations,
          description: args.bundle.description || undefined,
        }),
      );
      continue;
    }

    const categories = new Set<string>();
    if (hasPlural) {
      const lackedBySource = (sourceMissing ??= missingVariants(
        sourceMessage,
        declarations,
      ));
      // an empty form is missing, like one the target doesn't have
      missingVariants(target, declarations, {
        variants: target.variants.filter(
          (variant) => !isEmptyPattern(variant.pattern),
        ),
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
      const existingVariant =
        findMatchingVariant({
          variants: target.variants,
          matches: sourceVariant.matches,
          sourceVariants: sourceMessage.variants,
          declarations,
        }) ??
        // or the category that selects only the source's exact number: Arabic
        // "zero" is `=0`, as i18next's Arabic `_zero` is imported (see the
        // SDK's `variantCovers`). Only that: `findMatchingVariant` decides
        // about `other` and the catch-all.
        target.variants.find(
          (variant) =>
            variantCovers(
              variant,
              sourceVariant.matches,
              declarations,
              targetLocale,
            ) && !variantCovers(variant, sourceVariant.matches, declarations),
        );

      // A blank variant is missing, as `inlang check` reports it, unless its
      // source is blank too: then a translation can't fill it.
      if (
        existingVariant &&
        (!isEmptyPattern(existingVariant.pattern) ||
          isEmptyPattern(sourceVariant.pattern))
      ) {
        continue;
      }

      missing.push({
        sourceVariant,
        matches: sourceVariant.matches,
        targetLocale,
        text: serializePattern(sourceVariant.pattern, {}),
        context: args.bundle.description || undefined,
      });
    }
    if (missing.length > missingBefore && unknownRules) {
      report.unknownPluralRules.push(targetLocale);
    }
  }

  return {
    ...report,
    missing,
    apply: (translations) => {
      const reasons = new Map<MissingTranslation, string[]>();
      for (const [translation, pattern] of translations) {
        const found = rejectionReasons(
          pattern,
          translation.sourceVariant.pattern,
        );
        if (found.length > 0) reasons.set(translation, found);
      }
      // a new message missing a form can match nothing and show the bundle
      // id, while for a missing message the runtime falls back to another
      // locale
      const rejectedNewMessages = new Set(
        [...reasons.keys()]
          .map((translation) => translation.targetLocale)
          .filter((locale) => !existingLocales.has(locale)),
      );
      const rejected = missing.filter(
        (translation) =>
          reasons.has(translation) ||
          rejectedNewMessages.has(translation.targetLocale),
      );

      const copy = structuredClone(args.bundle);
      const sourceMessage = copy.messages.find(
        (message) => message.locale === args.sourceLocale,
      )!;
      /** variants added to messages of `args.bundle`, by message */
      const addedVariants = new Map<
        BundleNested["messages"][number],
        Set<VariantRow>
      >();

      for (const translation of missing) {
        const pattern = translations.get(translation);
        if (!pattern || rejected.includes(translation)) continue;
        const { matches, targetLocale } = translation;
        const targetMessage = copy.messages.find(
          (message) => message.locale === targetLocale,
        );

        if (targetMessage) {
          const existingVariant = findMatchingVariant({
            variants: targetMessage.variants,
            matches,
            sourceVariants: sourceMessage.variants,
            declarations: copy.declarations,
          });

          // only an empty variant is missing a translation
          if (existingVariant) {
            existingVariant.pattern = pattern;
          } else {
            const variant = {
              id: randomUUID(),
              message_id: targetMessage.id,
              matches,
              pattern,
            } satisfies VariantRow;
            targetMessage.variants.push(variant);
            if (existingLocales.has(targetLocale)) {
              const added = addedVariants.get(targetMessage) ?? new Set();
              added.add(variant);
              addedVariants.set(targetMessage, added);
            }
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
                matches,
                pattern,
              } satisfies VariantRow,
            ],
          });
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
            formsByLocale.get(message.locale),
          ),
        );
      }
      return {
        data: copy,
        ...(replacedVariantIds.length > 0 ? { replacedVariantIds } : {}),
        rejected: rejected.map((translation) => ({
          locale: translation.targetLocale,
          reasons: reasons.get(translation) ?? [],
        })),
      };
    },
  };
}

/**
 * Why a translation can't be written, compared with the variant it was
 * translated from: `empty`, or the placeholders (`{count}`, `</b>`) it
 * dropped, added or changed, and its markup that doesn't nest where the
 * source's does. Placeholders may move: word order differs between languages.
 * A provider gets each placeholder as JSON, which a model can change: another
 * `currency` option, a lost `</b>`.
 */
function rejectionReasons(
  pattern: VariantRow["pattern"],
  source: VariantRow["pattern"],
): string[] {
  if (isEmptyPattern(pattern) && !isEmptyPattern(source)) return ["empty"];
  const placeholders = pattern.filter((part) => part.type !== "text");
  const sourcePlaceholders = source.filter((part) => part.type !== "text");
  const changed = [
    ...without(sourcePlaceholders, placeholders),
    ...without(placeholders, sourcePlaceholders),
  ];
  // a changed placeholder says enough, while markup that only moved can
  // still nest wrongly
  const wrong =
    changed.length > 0 ? changed : without(unnested(pattern), unnested(source));
  return [...new Set(wrong.map(placeholderName))];
}

/**
 * `parts` without one equal part, whatever its key order, for each part of
 * `others`.
 */
function without(
  parts: VariantRow["pattern"],
  others: VariantRow["pattern"],
): VariantRow["pattern"] {
  const left = [...others];
  return parts.filter((part) => {
    const index = left.findIndex((other) => isDeepStrictEqual(part, other));
    if (index !== -1) left.splice(index, 1);
    return index === -1;
  });
}

/**
 * The markup of a pattern that doesn't nest: each end that doesn't close the
 * latest open start, which must have its name, and the starts left open.
 */
function unnested(pattern: VariantRow["pattern"]): VariantRow["pattern"] {
  const open: MarkupStart[] = [];
  const stray: MarkupEnd[] = [];
  for (const part of pattern) {
    if (part.type === "markup-start") {
      open.push(part);
    } else if (part.type === "markup-end") {
      if (open.at(-1)?.name === part.name) open.pop();
      else stray.push(part);
    }
  }
  return [...stray, ...open];
}

/** A placeholder as the user writes it: `{count}`, `<b>`, `</b>`, `<br/>`. */
function placeholderName(part: VariantRow["pattern"][number]): string {
  switch (part.type) {
    case "expression":
      return part.arg.type === "variable-reference"
        ? `{${part.arg.name}}`
        : `{|${part.arg.value}|}`;
    case "markup-start":
      return `<${part.name}>`;
    case "markup-end":
      return `</${part.name}>`;
    case "markup-standalone":
      return `<${part.name}/>`;
    case "text":
      return part.value;
  }
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
 * True when a source form is in a branch none of `forms` has. A branch is a
 * form's value for each selector but its plurals, whose categories differ by
 * locale; a selector a form leaves out is its catch-all.
 */
function dropsSourceBranch(
  source: BundleNested["messages"][number],
  forms: VariantRow["matches"][],
  declarations: BundleNested["declarations"],
): boolean {
  const selectors = source.selectors
    .map(({ name }) => name)
    .filter((name) => !isPluralSelector(name, declarations));
  return source.variants.some(
    (variant) =>
      !forms.some((matches) =>
        selectors.every(
          (name) => matchValue({ matches }, name) === matchValue(variant, name),
        ),
      ),
  );
}

/**
 * True when a plural of the message has no known rules in its locale (an
 * unknown locale, or options only known at runtime), so the SDK requires only
 * its catch-all. A plural whose `type` a select chooses has known rules when
 * its cardinal rules are known; one whose `type` no select chooses doesn't.
 */
function hasUnknownPluralRules(
  message: Parameters<typeof selectorGroups>[0],
  declarations: BundleNested["declarations"],
): boolean {
  return selectorGroups(message, declarations).some(
    (group) =>
      group.isPlural &&
      !pluralRules(
        group.selector,
        declarations,
        message.locale,
        // no matches: the catch-all type, cardinal; without a type selector a
        // `type=$pluralType` plural's rules are unknown
        group.typeSelector ? [] : undefined,
      ),
  );
}

/**
 * The forms of `forms` (the target's, see the SDK's `requiredVariants`) that
 * no non-empty variant of the target has, each translated from its source
 * variant (see the SDK's `sourceVariantFor`): Russian `few` from English `*`.
 * A form without one (a select value only the target has) is left missing.
 * Every empty variant of a form is filled, such as an empty `other` next to
 * a `*`.
 *
 * Where a plural's category isn't the source variant's, the context says
 * which form to write and for which numbers, after the bundle description:
 * a provider gets the same text for Russian `few`, `many` and `*`.
 */
function missingForms(args: {
  target: { locale: string; variants: VariantRow[] };
  forms: VariantRow["matches"][];
  sourceMessage: BundleNested["messages"][number];
  sourceLocale: string;
  declarations: BundleNested["declarations"];
  description: string | undefined;
}): MissingTranslation[] {
  const { target, forms, sourceMessage, declarations } = args;
  const missing: MissingTranslation[] = [];
  for (const form of forms) {
    const covering = target.variants.filter((variant) =>
      variantCovers(variant, form, declarations, target.locale),
    );
    // an empty `other` can be shown instead of a filled `*` (a literal key is
    // preferred, or stored first), so it is still missing
    const empty = covering.filter((variant) => isEmptyPattern(variant.pattern));
    if (covering.length > 0 && empty.length === 0) continue;
    const sourceVariant = sourceVariantFor({
      target: form,
      reference: sourceMessage.variants,
      declarations,
      referenceLocale: args.sourceLocale,
      targetLocale: target.locale,
    });
    // a blank source can't fill a blank variant
    if (
      !sourceVariant ||
      (empty.length > 0 && isEmptyPattern(sourceVariant.pattern))
    )
      continue;
    const plurals = form.flatMap(({ key }) => {
      if (!isPluralSelector(key, declarations)) return [];
      const category = categoryOf({ matches: form }, key);
      const sourceCategory = categoryOf(sourceVariant, key);
      if (category === sourceCategory) return [];
      // of the type the form matches, for a `type=$pluralType` plural
      const rules = pluralRules(key, declarations, target.locale, form)!;
      const examples = pluralExamples(
        // `pt_BR` as written in some projects: Intl needs `pt-BR`
        target.locale.replace(/_/g, "-"),
        rules.type,
        { offset: rules.offset },
      )[category];
      return [
        `Plural form: ${category} (${rules.type}) in ${target.locale}, used for n = ${examples}. Translate as the ${category} form; the source shows the ${sourceCategory} form.`,
      ];
    });
    // the matches of a variant added for the form
    const added = form.map((match) => {
      const source = sourceVariant.matches.find(
        (other) => other.key === match.key,
      );
      // a source that writes its catch-all as `other` keeps doing so. One
      // with a `*` too never shows that `*` (`other` takes every number
      // left), so the target's `*` is translated from `other`.
      return match.type === "catchall-match" &&
        source?.type === "literal-match" &&
        source.value === "other" &&
        !findMatchingVariant({
          variants: sourceMessage.variants,
          matches: sourceVariant.matches.map((other) =>
            other === source ? match : other,
          ),
          sourceVariants: sourceMessage.variants,
          declarations,
        })
        ? source
        : match;
    });
    const context =
      [args.description, plurals.join("\n")].filter(Boolean).join("\n\n") ||
      undefined;
    for (const matches of empty.length > 0
      ? empty.map((variant) => variant.matches)
      : [added]) {
      missing.push({
        sourceVariant,
        matches,
        targetLocale: target.locale,
        text: serializePattern(sourceVariant.pattern, {}),
        context,
      });
    }
  }
  return missing;
}

/** A variant's plural category for a selector: its catch-all is `other`. */
function categoryOf(variant: Pick<VariantRow, "matches">, selector: string) {
  const value = matchValue(variant, selector);
  return value === "*" ? "other" : value;
}

/**
 * Translates the missing translations with at most `MAX_CONCURRENT_REQUESTS`
 * requests in flight. A batch provider gets the texts of each target locale in
 * requests of at most `MAX_TEXTS_PER_REQUEST`; a single-text provider gets
 * one request per text.
 *
 * Stops starting requests at the first failure, returned or thrown, and
 * returns it once the requests in flight have settled, with the translations
 * that came back.
 */
export async function translateMissing(args: {
  provider: AnyMachineTranslateProvider;
  sourceLocale: string;
  missing: MissingTranslation[];
  /** Called with the number of texts each successful request translated. */
  onProgress?: (translated: number) => void;
}): Promise<
  ({ ok: true } | TranslateFailure) & {
    translations: Map<MissingTranslation, VariantRow["pattern"]>;
  }
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
        // The texts that did come back are kept, as with any failure, even
        // when one of them is missing or isn't a valid pattern.
        let textError: string | undefined;
        for (const [index, translation] of chunk.entries()) {
          const text = result.translatedTexts?.[String(index)];
          if (text === undefined) {
            textError ??= `No translation was returned for "${translation.text}".`;
            continue;
          }
          try {
            translations.set(translation, deserializePattern(text));
          } catch (error) {
            textError ??= String(error);
          }
        }
        if (!result.ok) return result;
        if (textError !== undefined) return { ok: false, error: textError };
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
  return { ...(failure ?? { ok: true }), translations };
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
 * An added form the source doesn't have (Russian `few`) goes before the first
 * form after it in `forms` (the target's, in the SDK's `requiredVariants`
 * order) that the source has, so the catch-all stays last. Any other variant
 * the source doesn't have (one written by hand) stays after the variant it
 * followed. Messages whose order doesn't change keep every id.
 */
export function orderLikeSource(
  message: { variants: VariantRow[] },
  sourceVariants: VariantRow[],
  added: Set<VariantRow>,
  declarations: BundleNested["declarations"],
  forms: VariantRow["matches"][] = [],
): string[] {
  const sourceIndex = (variant: Pick<VariantRow, "matches">) =>
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
    if (key === -1 && added.has(variant)) {
      const form = forms.findIndex((matches) =>
        variantCovers(variant, matches, declarations),
      );
      const next = forms
        .slice(form + 1)
        .map((matches) => sourceIndex({ matches }))
        .find((index) => index !== -1);
      // before that form, after the variants before it
      key = next! - 0.5;
    }
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
