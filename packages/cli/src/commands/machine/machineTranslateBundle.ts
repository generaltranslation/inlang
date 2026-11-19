// uuid v7: variants are ordered by id, so the translated variants keep the
// order of the source message
import { v7 as randomUUID } from "uuid";
import {
  isEmptyPattern,
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

/**
 * The translations a bundle is missing, and how to add them to it once they
 * are translated.
 */
export type BundleTranslationPlan = {
  missing: MissingTranslation[];
  /**
   * Target locales the bundle has no message in. Added with only some of its
   * translations, such a message could match nothing: half a plural.
   */
  newLocales: Set<string>;
  /**
   * Adds the translation of each of `missing` that `translations` has to a
   * copy of the bundle.
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
};

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
  // a locale given twice is translated once
  const targetLocales = new Set(args.targetLocales);
  for (const sourceVariant of sourceMessage.variants) {
    const text = serializePattern(sourceVariant.pattern, {});

    for (const targetLocale of targetLocales) {
      if (targetLocale === args.sourceLocale) {
        continue;
      }

      const targetMessage = args.bundle.messages.find(
        (message) => message.locale === targetLocale,
      );
      const existingVariant =
        targetMessage &&
        findMatchingVariant(targetMessage.variants, sourceVariant.matches);

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
        text,
        context: args.bundle.description || undefined,
      });
    }
  }

  return {
    missing,
    newLocales: new Set(
      [...targetLocales].filter(
        (locale) =>
          !args.bundle.messages.some((message) => message.locale === locale),
      ),
    ),
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
        const pattern = translations.get(translation);
        if (!pattern) continue;
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

  const byLocale = new Map<string, MissingTranslation[]>();
  for (const translation of args.missing) {
    const missing = byLocale.get(translation.targetLocale) ?? [];
    missing.push(translation);
    byLocale.set(translation.targetLocale, missing);
  }

  const translations = new Map<MissingTranslation, VariantRow["pattern"]>();
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
