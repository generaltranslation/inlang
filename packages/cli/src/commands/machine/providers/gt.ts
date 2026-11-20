import type {
  BatchMachineTranslateProvider,
  TranslateBatchArgs,
} from "./types.js";
import { rateLimitOf, scopeOf } from "./rateLimit.js";

const GT_TRANSLATE_API_URL = "https://api.gtx.dev/v2/translate";
/**
 * The API contract the request and the response parsing are written for.
 * Without it, the API answers with its oldest supported contract.
 */
export const GT_API_VERSION = "2026-03-06.v1";
export const GT_DASHBOARD_URL = "https://dash.generaltranslation.com";
// A batch of texts can take a while; this only ends a request that hangs.
const GT_REQUEST_TIMEOUT_MINUTES = 5;

// Shown in the dashboard as "Runtime translation"; /v2/translate requires it.
const RUNTIME_TRANSLATION_PERMISSION = "project:translations:generate";

const timedOut = {
  ok: false,
  error: `General Translation didn't answer within ${GT_REQUEST_TIMEOUT_MINUTES} minutes.`,
} as const;

export function createGtTranslateProvider(args: {
  apiKey: string;
  projectId?: string;
  userAgent: string;
}): BatchMachineTranslateProvider {
  return {
    supportsContext: true,
    async translateBatch({
      sourceLocale,
      targetLocale,
      texts,
    }: TranslateBatchArgs) {
      const requests = Object.fromEntries(
        Object.entries(texts).map(([key, { text, context }]) => [
          key,
          {
            source: text,
            metadata: { dataFormat: "STRING", context },
          },
        ]),
      );

      let response: Response;
      try {
        response = await fetch(GT_TRANSLATE_API_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${args.apiKey}`,
            "Content-Type": "application/json",
            "User-Agent": args.userAgent,
            "gt-api-version": GT_API_VERSION,
            ...(args.projectId ? { "gt-project-id": args.projectId } : {}),
          },
          body: JSON.stringify({
            sourceLocale,
            targetLocale,
            metadata: {},
            requests,
          }),
          signal: AbortSignal.timeout(GT_REQUEST_TIMEOUT_MINUTES * 60_000),
        });
      } catch (error) {
        if ((error as Error).name === "TimeoutError") return timedOut;
        // Never quote the message: it can contain the Authorization header.
        // Network errors carry a code; errors without one are thrown before
        // sending, typically for a header value fetch can't encode.
        const code = (error as { cause?: { code?: unknown } }).cause?.code;
        return {
          ok: false,
          error:
            typeof code === "string"
              ? `General Translation could not be reached (${code}).`
              : "The General Translation API key or project ID contains characters that can't be sent.",
        };
      }

      if (response.status === 401) {
        return {
          ok: false,
          error: `General Translation rejected the API key. Get a key from your project at ${GT_DASHBOARD_URL}.`,
        };
      }

      if (!response.ok) {
        // Every other failure explains itself in the body: `{ error, code }`.
        let body: string;
        try {
          body = await response.text();
        } catch (error) {
          // The timeout covers reading the answer too.
          if ((error as Error).name === "TimeoutError") return timedOut;
          body = "";
        }
        const { message, code } = errorOf(body);

        if (response.status === 402) {
          // The API uses 402 for the free plan's monthly limit, the spend limit
          // and the balance, each with its own message. Only the first line:
          // the balance's goes on with an estimate that is only this batch's.
          const reason = reasonOf(message, args.apiKey, { firstLine: true });
          return {
            ok: false,
            error: reason
              ? `General Translation rejected the request: ${reason} Billing settings: ${GT_DASHBOARD_URL}`
              : `General Translation could not bill this request. Check your billing: ${GT_DASHBOARD_URL}`,
          };
        }

        if (response.status === 403) {
          if (body.includes(RUNTIME_TRANSLATION_PERMISSION)) {
            return {
              ok: false,
              error: `General Translation rejected the request: this API key needs the Runtime translation permission. Edit the key at ${GT_DASHBOARD_URL}.`,
            };
          }
          // Other reasons, such as a locale the GT project doesn't allow, aren't
          // about the key, so only a bare 403 points to it.
          const reason = reasonOf(message, args.apiKey);
          return {
            ok: false,
            // A locale the GT project doesn't allow fails only its own texts,
            // so the other locales are still translated.
            ...(code === "locale_not_allowed"
              ? { scope: "text" as const }
              : {}),
            error: reason
              ? `General Translation rejected the request: ${reason}`
              : `General Translation rejected the request. Check the API key at ${GT_DASHBOARD_URL}.`,
          };
        }

        const reason = reasonOf(message, args.apiKey);
        // Over HTTP/2 the status text is empty.
        const status = [response.status, response.statusText]
          .filter(Boolean)
          .join(" ");
        return {
          ok: false,
          scope: scopeOf(response.status),
          ...rateLimitOf(response),
          error: reason
            ? `General Translation answered ${response.status} translating from ${sourceLocale} to ${targetLocale}: ${reason}`
            : `General Translation answered ${status} translating from ${sourceLocale} to ${targetLocale}.`,
        };
      }

      let json: Record<string, any>;
      try {
        json = await response.json();
      } catch (error) {
        // The timeout covers reading the answer too.
        if ((error as Error).name === "TimeoutError") return timedOut;
        throw error;
      }
      const translations: [string, string][] = [];
      const failures: string[] = [];
      for (const key of Object.keys(texts)) {
        const result = json[key];
        if (
          result?.success === true &&
          typeof result.translation === "string"
        ) {
          translations.push([key, result.translation]);
        } else {
          failures.push(result?.error ?? "no translation was returned");
        }
      }

      if (failures.length > 0) {
        return {
          ok: false,
          scope: "text",
          error: `${failures.length} of ${Object.keys(texts).length} translations from ${sourceLocale} to ${targetLocale} failed: ${failures[0]}`,
          translatedTexts: Object.fromEntries(translations),
        };
      }

      return { ok: true, translatedTexts: Object.fromEntries(translations) };
    },
  };
}

/**
 * The `error` and `code` of an error response's body: General Translation's
 * JSON, or a plain-text body as the message.
 */
function errorOf(body: string): { message: unknown; code: unknown } {
  try {
    const json = JSON.parse(body);
    return { message: json?.error, code: json?.code };
  } catch {
    // Not JSON: the body is the message.
    return { message: body, code: undefined };
  }
}

/**
 * An error message as one line ending a sentence, or nothing for a message
 * that isn't worth showing, such as an HTML page. The API key is never quoted.
 */
function reasonOf(
  message: unknown,
  apiKey: string,
  options: { firstLine?: boolean } = {},
): string | undefined {
  if (typeof message !== "string") return undefined;
  let text = (options.firstLine ? message.trim().split("\n")[0]! : message)
    .replace(/\s+/g, " ")
    // No terminal escape sequences from a proxy's answer.
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .trim();
  if (!text || text.startsWith("<") || text.length > 300) return undefined;
  if (apiKey) text = text.replaceAll(apiKey, "***");
  return /[.!?]$/.test(text) ? text : `${text}.`;
}
