// uuid v7: variants are ordered by id, so the translated variants keep the
// order of the source message
import { isDeepStrictEqual } from "node:util";
import { v7 as randomUUID } from "uuid";
import {
  isEmptyPattern,
  isPluralSelector,
  matchValue,
  missingVariants,
  pluralRules,
  resolveAnnotation,
  resolveInputVariable,
  spelledOutInputs,
  selectorGroups,
  variantCovers,
  type BundleNested,
  type Declaration,
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
  TranslateBatchResult,
  TranslateFailure,
} from "./providers/types.js";

/**
 * Texts per batch request. Keeps request bodies small while a large project
 * needs only a few requests per locale.
 */
const MAX_TEXTS_PER_REQUEST = 50;

/**
 * Batch requests in flight at once. Sending every request at once runs into
 * the providers' rate limits on large projects.
 */
const MAX_CONCURRENT_REQUESTS = 4;

/**
 * Requests in flight at once for a provider that translates one text per
 * request (Google, DeepL, OpenAI; the community service sends at most 6 of
 * them at once). With only 4, a large project would take minutes;
 * rate-limited requests are sent again.
 */
const MAX_CONCURRENT_TEXT_REQUESTS = 16;

/**
 * A rate-limited request (429) is sent again at most this many times, after
 * its `Retry-After` or else 2s, 4s, 8s. A 429 means the request wasn't
 * processed, so sending it again doesn't pay twice. Other failures aren't
 * retried: a 5xx or network error may have been processed.
 */
const MAX_RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_BASE_DELAY_MS = 2_000;

/**
 * The most one request waits for rate limits in total. A provider that asks
 * for longer fails the run at once, saving what came back.
 */
const MAX_RATE_LIMIT_WAIT_MS = 60_000;

/** Waits `ms`, or less if `signal` aborts. */
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });

/**
 * Sends a request again while it is rate-limited, within
 * `MAX_RATE_LIMIT_RETRIES` and `MAX_RATE_LIMIT_WAIT_MS`. Once `stop` aborts,
 * because another request failed for good, it stops waiting and doesn't
 * send the request again.
 */
async function retryRateLimited(
  send: () => Promise<TranslateBatchResult>,
  wait: (ms: number, signal: AbortSignal) => Promise<void>,
  stop: AbortSignal,
): Promise<TranslateBatchResult> {
  let waited = 0;
  for (let retry = 0; ; retry++) {
    const result = await send();
    if (result.ok || !result.rateLimited) return result;
    const delay = result.retryAfterMs ?? RATE_LIMIT_BASE_DELAY_MS * 2 ** retry;
    if (delay + waited > MAX_RATE_LIMIT_WAIT_MS) {
      return {
        ...result,
        error: `${result.error} (rate limited: the provider asked to wait ${Math.ceil(delay / 1000)} s${waited > 0 ? ` after ${Math.ceil(waited / 1000)} s of waiting` : ""}. Run again later.)`,
      };
    }
    if (retry >= MAX_RATE_LIMIT_RETRIES) {
      return {
        ...result,
        error: `${result.error} (still rate limited after ${retry} retries. Run again later.)`,
      };
    }
    if (stop.aborted) return result;
    waited += delay;
    await wait(delay, stop);
    if (stop.aborted) return result;
  }
}

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
   * Target locales whose plurals need categories no source variant has, with
   * those categories. The source's forms are still translated, as they were
   * before these were reported; the categories stay missing until they are
   * added by hand. Whether the runtime falls back to another form for their
   * numbers depends on the message format: i18next shows the key. A
   * translation whose selectors aren't the source's, such as a hand-written
   * plural of a text, is left as it is: the source's forms wouldn't fit it.
   */
  incompletePlurals: Array<{ locale: string; categories: string[] }>;
  /**
   * Target locales whose message has other selectors than the source's, in
   * any order, such as a hand-written text without the source's plural. The
   * source's forms match on selectors such a message doesn't have, so it is
   * left as it is. It is reported when it lacks a form its own selectors
   * need, or has it empty, also when `incompletePlurals` has it: the source
   * can't fill any of its forms.
   */
  differentSelectors: string[];
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
   * Target locales the bundle has no message in, or a message without forms,
   * which gets the source's selectors. Added with only some of its
   * translations, such a message could match nothing: half a plural.
   */
  newLocales: Set<string>;
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
 * Reports target locales whose plurals need categories the source lacks, see
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
  const newLocales = new Set<string>();
  /**
   * Locales whose target has a variant for every form its language needs,
   * counting a literal `other` only for the catch-all (see
   * `findMatchingVariant`)
   */
  const complete = new Set<string>();
  const report: PluralReport = {
    incompletePlurals: [],
    differentSelectors: [],
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
    // A message without forms gets the source's, with the source's selectors
    // (see `apply`), like a new one: its own select nothing.
    const isNew = !targetMessage || targetMessage.variants.length === 0;
    if (isNew) newLocales.add(targetLocale);
    const target = {
      locale: targetLocale,
      selectors: isNew ? sourceMessage.selectors : targetMessage.selectors,
      variants: targetMessage?.variants ?? [],
    };
    const categories = new Set<string>();
    // The forms are the target's, so without a plural in the target no
    // category can be missing. `missingVariants` takes seconds on a message
    // with several selects, so it isn't called then (but for the rare target
    // with other selectors than the source's, below).
    if (
      target.selectors.some(({ name }) => isPluralSelector(name, declarations))
    ) {
      // With the source's forms, which the plan adds: a catch-all covers no
      // category such as `one`. Empty variants count, as an empty `other` is
      // filled from the catch-all.
      if (
        missingVariants(target, declarations, {
          variants: [...target.variants, ...sourceMessage.variants],
        }).length === 0
      ) {
        complete.add(targetLocale);
      }
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
    // in any order
    const names = (selectors: typeof target.selectors) =>
      selectors
        .map(({ name }) => name)
        .sort()
        .join();
    const sameSelectors =
      names(target.selectors) === names(sourceMessage.selectors);
    if (categories.size > 0) {
      report.incompletePlurals.push({
        locale: targetLocale,
        categories: [...categories],
      });
    }
    // The source's forms would be added with selectors the message doesn't
    // have, so it could never select them. It is reported when it has an
    // empty form, which runtimes select before a filled catch-all, or lacks
    // one its selectors need.
    if (!sameSelectors) {
      if (
        target.variants.some((variant) => isEmptyPattern(variant.pattern)) ||
        missingVariants(target, declarations).length > 0
      ) {
        report.differentSelectors.push(targetLocale);
      }
      continue;
    }

    const missingBefore = missing.length;
    for (const sourceVariant of sourceMessage.variants) {
      const existingVariant = findMatchingVariant({
        variants: target.variants,
        matches: sourceVariant.matches,
        sourceVariants: sourceMessage.variants,
        declarations,
        otherIsCatchAll: complete.has(targetLocale),
      });

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

  return {
    ...report,
    missing,
    newLocales,
    apply: (translations) => {
      const reasons = new Map<MissingTranslation, string[]>();
      for (const [translation, pattern] of translations) {
        const found = rejectionReasons(
          pattern,
          translation.sourceVariant.pattern,
          spelledOutInputs(
            translation.sourceVariant,
            declarations,
            translation.targetLocale,
          ),
          declarations,
        );
        if (found.length > 0) reasons.set(translation, found);
      }
      // a new message missing a form can match nothing and show the bundle
      // id, while for a missing message the runtime falls back to another
      // locale. A message without forms is new too (see `newLocales`).
      const rejectedNewMessages = new Set(
        [...reasons.keys()]
          .map((translation) => translation.targetLocale)
          .filter((locale) => newLocales.has(locale)),
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
      /** variants added to messages that existed, by message */
      const addedVariants = new Map<
        BundleNested["messages"][number],
        Set<VariantRow>
      >();

      for (const translation of missing) {
        const pattern = translations.get(translation);
        if (!pattern || rejected.includes(translation)) continue;
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
            otherIsCatchAll: complete.has(targetLocale),
          });

          // only an empty variant is missing a translation
          if (existingVariant) {
            existingVariant.pattern = pattern;
          } else {
            if (targetMessage.variants.length === 0) {
              targetMessage.selectors = structuredClone(
                sourceMessage.selectors,
              );
            }
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
          ...orderLikeSource(
            message,
            sourceMessage.variants,
            added,
            copy.declarations,
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
 * dropped, added or changed (a fixed count may be spelled out), and its markup
 * that doesn't nest where the
 * source's does. Placeholders may move: word order differs between languages.
 * A provider gets each placeholder as JSON, which a model can change: another
 * `currency` option, a lost `</b>`.
 */
function rejectionReasons(
  pattern: VariantRow["pattern"],
  source: VariantRow["pattern"],
  spelledOut: string[],
  declarations: BundleNested["declarations"],
): string[] {
  if (isEmptyPattern(pattern) && !isEmptyPattern(source)) return ["empty"];
  const placeholders = pattern.filter((part) => part.type !== "text");
  const sourcePlaceholders = source.filter((part) => part.type !== "text");
  const changed = [
    ...without(sourcePlaceholders, placeholders).filter((part) => {
      if (part.type !== "expression" || part.arg.type !== "variable-reference")
        return true;
      // Plain counts and ICU # can be written in words; currency and unit
      // formatters still carry meaning beyond the selected number.
      const annotation =
        part.annotation ?? resolveAnnotation(part.arg.name, declarations);
      return (
        !spelledOut.includes(
          resolveInputVariable(part.arg.name, declarations),
        ) ||
        (annotation !== undefined && annotation.name !== "icu:pound")
      );
    }),
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
 * Translates the missing translations. A batch provider gets the texts of each
 * target locale in requests of at most `MAX_TEXTS_PER_REQUEST`, with at most
 * `MAX_CONCURRENT_REQUESTS` in flight; a single-text provider gets one request
 * per text, with at most `MAX_CONCURRENT_TEXT_REQUESTS` in flight.
 *
 * A failed text does not stop unrelated requests. A rate-limited request is
 * sent again (see `MAX_RATE_LIMIT_RETRIES`). A provider failure (including a
 * thrown network error, or a rate limit that outlasts the retries) stops new
 * requests; those in flight still settle.
 * Returns every failure and the translations that came back.
 */
export async function translateMissing(args: {
  provider: AnyMachineTranslateProvider;
  sourceLocale: string;
  missing: MissingTranslation[];
  /** Called with the number of texts each successful request translated. */
  onProgress?: (translated: number) => void;
  /** Waits before a rate-limited request is sent again; for tests. */
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
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
            signal: stop.signal,
          });
          return result.ok
            ? { ok: true, translatedTexts: { [key]: result.translatedText } }
            : result;
        };
  const textsPerRequest = batched ? MAX_TEXTS_PER_REQUEST : 1;

  const translations = new Map<MissingTranslation, VariantRow["pattern"]>();
  // A blank source can't be translated, and a provider may reject it, so it
  // is copied as it is: dropping it would leave a new message without a form
  // the source has, such as a blank catch-all.
  const blank = args.missing.filter(({ sourceVariant }) =>
    isEmptyPattern(sourceVariant.pattern),
  );
  for (const translation of blank) {
    translations.set(
      translation,
      structuredClone(translation.sourceVariant.pattern),
    );
  }
  if (blank.length > 0) args.onProgress?.(blank.length);

  const byLocale = new Map<string, MissingTranslation[]>();
  for (const translation of args.missing) {
    if (translations.has(translation)) continue;
    const missing = byLocale.get(translation.targetLocale) ?? [];
    missing.push(translation);
    byLocale.set(translation.targetLocale, missing);
  }

  /** Aborts on a provider failure: no request is sent after it. */
  const stop = new AbortController();
  /** Each sends one request and records what it translated. */
  const requests: Array<() => Promise<{ ok: true } | TranslateFailure>> = [];
  for (const [targetLocale, missing] of byLocale) {
    for (let start = 0; start < missing.length; start += textsPerRequest) {
      const chunk = missing.slice(start, start + textsPerRequest);
      requests.push(async () => {
        // keyed by position, not by source variant id, so that one source
        // variant can have several translations into a locale (e.g. one per
        // plural form of the target language), each with its own context
        const result = await retryRateLimited(
          () =>
            translateBatch({
              sourceLocale,
              targetLocale,
              texts: Object.fromEntries(
                chunk.map(({ text, context }, index) => [
                  String(index),
                  { text, context },
                ]),
              ),
            }),
          args.wait ?? sleep,
          stop.signal,
        );
        // The texts that did come back are kept, as with any failure, even
        // when one of them is missing or isn't a valid pattern.
        let textError: string | undefined;
        for (const [index, translation] of chunk.entries()) {
          const text: unknown = result.translatedTexts?.[String(index)];
          if (text === undefined) {
            textError ??= `No translation was returned for "${translation.text}".`;
            continue;
          }
          // a malformed answer, such as 42 or {}, would parse as a blank text
          if (typeof text !== "string") {
            textError ??= `The translation of "${translation.text}" isn't text.`;
            continue;
          }
          try {
            translations.set(translation, deserializePattern(text));
          } catch (error) {
            textError ??= String(error);
          }
        }
        if (!result.ok) return result;
        if (textError !== undefined)
          return { ok: false, error: textError, scope: "text" };
        args.onProgress?.(chunk.length);
        return result;
      });
    }
  }

  const errors = new Set<string>();
  let next = 0;
  const worker = async () => {
    while (!stop.signal.aborted && next < requests.length) {
      // Thrown errors, such as network failures, are provider-wide.
      const result = await requests[next++]!().catch(
        (error): TranslateFailure => ({ ok: false, error: String(error) }),
      );
      if (!result.ok) {
        // a rate limit whose retry the stop cut short, or a request the stop
        // kept from being sent, isn't a cause of its own
        if (!((result.rateLimited || result.stopped) && stop.signal.aborted)) {
          errors.add(result.error);
        }
        if (result.scope !== "text") stop.abort();
      }
    }
  };
  await Promise.all(
    Array.from(
      {
        length: batched
          ? MAX_CONCURRENT_REQUESTS
          : MAX_CONCURRENT_TEXT_REQUESTS,
      },
      () => worker(),
    ),
  );
  return errors.size > 0
    ? { ok: false, error: [...errors].join("\n"), translations }
    : { ok: true, translations };
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
          // only for the order: an `other` goes where the catch-all would
          otherIsCatchAll: true,
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
