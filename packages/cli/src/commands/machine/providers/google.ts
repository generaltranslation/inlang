import type { MachineTranslateProvider, TranslateTextArgs } from "./types.js";
import { rateLimitOf, scopeOf } from "./rateLimit.js";

export function createGoogleTranslateProvider(
  apiKey: string,
): MachineTranslateProvider {
  return {
    async translateText(args: TranslateTextArgs) {
      const response = await fetch(
        "https://translation.googleapis.com/language/translate/v2?" +
          new URLSearchParams({
            q: args.text,
            target: args.targetLocale,
            source: args.sourceLocale,
            format: "html",
            key: apiKey,
          }),
        { method: "POST" },
      );

      if (!response.ok) {
        return {
          ok: false,
          scope: scopeOf(response.status),
          ...rateLimitOf(
            response,
            response.status === 429 || (await isRateLimit403(response)),
          ),
          error: `${response.status} ${response.statusText}: translating from ${args.sourceLocale} to ${args.targetLocale}`,
        };
      }

      const json = await response.json();
      return {
        ok: true,
        translatedText: json.data.translations[0].translatedText,
      };
    },
  };
}

/**
 * Translation API v2 answers a per-minute quota with 403 and the reason
 * `rateLimitExceeded` or `userRateLimitExceeded`, not 429. A daily quota
 * (`dailyLimitExceeded`) isn't retried: waiting a minute doesn't lift it.
 */
async function isRateLimit403(response: Response): Promise<boolean> {
  if (response.status !== 403) return false;
  let body: any;
  try {
    body = await response.json();
  } catch {
    return false;
  }
  const errors: unknown = body?.error?.errors;
  return (
    Array.isArray(errors) &&
    errors.some(
      (error) =>
        error?.reason === "rateLimitExceeded" ||
        error?.reason === "userRateLimitExceeded",
    )
  );
}
