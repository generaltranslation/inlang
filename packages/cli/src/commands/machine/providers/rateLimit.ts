import type { TranslateFailure } from "./types.js";

/**
 * How far a failed response reaches: a 400, 413 or 422 is about the text
 * sent, so other requests are worth trying; anything else is provider-wide.
 */
export function scopeOf(status: number): TranslateFailure["scope"] {
  return [400, 413, 422].includes(status) ? "text" : "provider";
}

/**
 * The fields of a failed response's `TranslateFailure` that let the run retry
 * it: a 429 is rate-limited, or another status a provider uses for its rate
 * limit, with how long its `Retry-After` header asks to wait. Other responses
 * get none.
 */
export function rateLimitOf(
  response: Response,
  rateLimited = response.status === 429,
): Pick<TranslateFailure, "rateLimited" | "retryAfterMs"> {
  if (!rateLimited) return {};
  const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
  return {
    rateLimited: true,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
}

/**
 * A `Retry-After` header in milliseconds: seconds, or an HTTP date. A date
 * in the past is 0; a value that is neither is ignored.
 */
export function parseRetryAfter(
  value: string | null,
  now = Date.now(),
): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}
