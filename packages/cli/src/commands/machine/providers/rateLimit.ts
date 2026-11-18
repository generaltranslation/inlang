import type { TranslateFailure } from "./types.js";

/**
 * The fields of a failed response's `TranslateFailure` that let the run retry
 * it: a 429 is rate-limited, with how long its `Retry-After` header asks to
 * wait. Other responses get none.
 */
export function rateLimitOf(
  response: Response,
): Pick<TranslateFailure, "rateLimited" | "retryAfterMs"> {
  if (response.status !== 429) return {};
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
