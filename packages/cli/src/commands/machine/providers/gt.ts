import type {
  BatchMachineTranslateProvider,
  TranslateBatchArgs,
} from "./types.js";
import { rateLimitOf } from "./rateLimit.js";

const GT_TRANSLATE_API_URL = "https://api.gtx.dev/v2/translate";
/**
 * The API contract the request and the response parsing are written for.
 * Without it, the API answers with its oldest supported contract.
 */
export const GT_API_VERSION = "2026-03-06.v1";
const GT_DASHBOARD_URL = "https://dash.generaltranslation.com";
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

      if (response.status === 402) {
        return {
          ok: false,
          error: `General Translation could not bill this request. Check your billing: ${GT_DASHBOARD_URL}`,
        };
      }

      if (response.status === 403) {
        let body: string;
        try {
          body = await response.text();
        } catch (error) {
          // The timeout covers reading the answer too.
          if ((error as Error).name === "TimeoutError") return timedOut;
          body = "";
        }
        if (body.includes(RUNTIME_TRANSLATION_PERMISSION)) {
          return {
            ok: false,
            error: `General Translation rejected the request: this API key needs the Runtime translation permission. Edit the key at ${GT_DASHBOARD_URL}.`,
          };
        }
        // Other reasons, such as a locale the GT project doesn't allow, aren't
        // about the key, so only a bare 403 points to it.
        const reason = reasonOf(body, args.apiKey);
        return {
          ok: false,
          error: reason
            ? `General Translation rejected the request: ${reason}`
            : `General Translation rejected the request. Check the API key at ${GT_DASHBOARD_URL}.`,
        };
      }

      if (!response.ok) {
        return {
          ok: false,
          scope: [400, 413, 422].includes(response.status)
            ? "text"
            : "provider",
          ...rateLimitOf(response),
          error: `${response.status} ${response.statusText}: translating from ${sourceLocale} to ${targetLocale}`,
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
 * The reason an error response gives, as one line ending a sentence: General
 * Translation's JSON `error`, or a short plain-text body, not an HTML page.
 * The API key is never quoted.
 */
function reasonOf(body: string, apiKey: string): string | undefined {
  let reason: unknown = body;
  try {
    reason = JSON.parse(body)?.error;
  } catch {
    // Not JSON: the body is the reason.
  }
  if (typeof reason !== "string") return undefined;
  let text = reason
    .replace(/\s+/g, " ")
    // No terminal escape sequences from a proxy's answer.
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .trim();
  if (!text || text.startsWith("<") || text.length > 300) return undefined;
  if (apiKey) text = text.replaceAll(apiKey, "***");
  return /[.!?]$/.test(text) ? text : `${text}.`;
}
