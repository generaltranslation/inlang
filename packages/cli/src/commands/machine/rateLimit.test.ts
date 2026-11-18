import { afterEach, expect, test, vi } from "vitest";
import type { BundleNested } from "@inlang/sdk";
import {
  planBundleTranslation,
  translateMissing,
} from "./machineTranslateBundle.js";
import { parseRetryAfter } from "./providers/rateLimit.js";
import { createOpenAITranslateProvider } from "./providers/openai.js";
import type {
  BatchMachineTranslateProvider,
  TranslateBatchResult,
} from "./providers/types.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function missing(count: number) {
  return Array.from({ length: count }, (_, index) => {
    const bundle: BundleNested = {
      id: `b${index}`,
      declarations: [],
      messages: [
        {
          id: `b${index}_en`,
          bundleId: `b${index}`,
          locale: "en",
          selectors: [],
          variants: [
            {
              id: `b${index}_en_v`,
              messageId: `b${index}_en`,
              matches: [],
              pattern: [{ type: "text", value: `Text ${index}` }],
            },
          ],
        },
      ],
    } as unknown as BundleNested;
    const plan = planBundleTranslation({
      bundle,
      sourceLocale: "en",
      targetLocales: ["de"],
    });
    if ("error" in plan) throw new Error(plan.error);
    return plan.missing;
  }).flat();
}

const rateLimited = (retryAfterMs?: number): TranslateBatchResult => ({
  ok: false,
  error: "429 Too Many Requests",
  rateLimited: true,
  ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
});

function provider(
  answers: TranslateBatchResult[],
): BatchMachineTranslateProvider & { calls: number } {
  const result = {
    calls: 0,
    translateBatch: async ({ texts }: { texts: Record<string, unknown> }) => {
      const answer = answers[result.calls++];
      return (
        answer ?? {
          ok: true,
          translatedTexts: Object.fromEntries(
            Object.keys(texts).map((key) => [key, "Übersetzt"]),
          ),
        }
      );
    },
  };
  return result;
}

test("a rate-limited request is sent again after the Retry-After the provider asked for", async () => {
  const waits: number[] = [];
  const fake = provider([rateLimited(1500)]);

  const result = await translateMissing({
    provider: fake,
    sourceLocale: "en",
    missing: missing(1),
    wait: async (ms) => void waits.push(ms),
  });

  expect(result.ok).toBe(true);
  expect(result.translations.size).toBe(1);
  expect(waits).toEqual([1500]);
  expect(fake.calls).toBe(2);
});

test("without Retry-After, waits 2s, 4s and 8s, then fails the run and starts no more requests", async () => {
  const waits: number[] = [];
  const fake = provider(Array.from({ length: 4 }, () => rateLimited()));

  const result = await translateMissing({
    provider: fake,
    sourceLocale: "en",
    missing: missing(1),
    wait: async (ms) => void waits.push(ms),
  });

  expect(waits).toEqual([2000, 4000, 8000]);
  expect(fake.calls).toBe(4);
  expect(result).toMatchObject({
    ok: false,
    error:
      "429 Too Many Requests (still rate limited after 3 retries. Run again later.)",
  });
});

test("a rate limit that outlasts the retries fails the run, keeping what came back", async () => {
  // 50 texts per request: the first request stays rate-limited, the second
  // (10 texts) runs beside it
  let rateLimitedCalls = 0;
  const fake: BatchMachineTranslateProvider = {
    translateBatch: async ({ texts }) => {
      if (
        "0" in texts &&
        Object.keys(texts).length === 50 &&
        rateLimitedCalls < 4
      ) {
        rateLimitedCalls++;
        return rateLimited();
      }
      return {
        ok: true,
        translatedTexts: Object.fromEntries(
          Object.keys(texts).map((key) => [key, "Übersetzt"]),
        ),
      };
    },
  };

  const result = await translateMissing({
    provider: fake,
    sourceLocale: "en",
    missing: missing(60),
    wait: async () => {},
  });

  expect(result.ok).toBe(false);
  expect(result.translations.size).toBe(10);
});

test("a Retry-After longer than the run waits in total fails at once, without waiting", async () => {
  const waits: number[] = [];
  const fake = provider([rateLimited(120_000)]);

  const result = await translateMissing({
    provider: fake,
    sourceLocale: "en",
    missing: missing(1),
    wait: async (ms) => void waits.push(ms),
  });

  expect(waits).toEqual([]);
  expect(fake.calls).toBe(1);
  expect(result).toMatchObject({
    ok: false,
    error:
      "429 Too Many Requests (rate limited: the provider asked to wait 120 s. Run again later.)",
  });
});

test("Retry-After waits add up to at most a minute per request", async () => {
  const waits: number[] = [];
  const fake = provider([
    rateLimited(30_000),
    rateLimited(30_000),
    rateLimited(30_000),
  ]);

  const result = await translateMissing({
    provider: fake,
    sourceLocale: "en",
    missing: missing(1),
    wait: async (ms) => void waits.push(ms),
  });

  expect(waits).toEqual([30_000, 30_000]);
  expect(result).toMatchObject({
    ok: false,
    error:
      "429 Too Many Requests (rate limited: the provider asked to wait 30 s after 60 s of waiting. Run again later.)",
  });
});

test("other failures, such as a 503 that may have been processed, aren't sent again", async () => {
  const waits: number[] = [];
  const fake = provider([
    { ok: false, error: "503 Service Unavailable", scope: "provider" },
  ]);

  const result = await translateMissing({
    provider: fake,
    sourceLocale: "en",
    missing: missing(1),
    wait: async (ms) => void waits.push(ms),
  });

  expect(waits).toEqual([]);
  expect(fake.calls).toBe(1);
  expect(result.ok).toBe(false);
});

test("Retry-After is read in seconds or as an HTTP date", () => {
  const now = Date.parse("2026-11-18T12:00:00Z");
  expect(parseRetryAfter("3", now)).toBe(3000);
  expect(parseRetryAfter(" 1.5 ", now)).toBe(1500);
  expect(parseRetryAfter("Wed, 18 Nov 2026 12:00:10 GMT", now)).toBe(10_000);
  expect(parseRetryAfter("Wed, 18 Nov 2026 11:59:00 GMT", now)).toBe(0);
  expect(parseRetryAfter("soon", now)).toBeUndefined();
  expect(parseRetryAfter(null, now)).toBeUndefined();
});

test("a provider's 429 is rate-limited, with its Retry-After", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(null, {
          status: 429,
          statusText: "Too Many Requests",
          headers: { "Retry-After": "7" },
        }),
    ),
  );
  const result = await createOpenAITranslateProvider("key").translateText({
    text: "Hello",
    sourceLocale: "en",
    targetLocale: "de",
  });
  expect(result).toMatchObject({
    ok: false,
    rateLimited: true,
    retryAfterMs: 7000,
  });
});
