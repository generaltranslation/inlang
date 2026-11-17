import type {
  BatchMachineTranslateProvider,
  TranslateBatchArgs,
} from "./types.js";

const GT_TRANSLATE_API_URL = "https://api.gtx.dev/v2/translate";
export const GT_DASHBOARD_URL = "https://dash.generaltranslation.com";

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
            metadata: { dataFormat: "STRING", ...(context ? { context } : {}) },
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
            ...(args.projectId ? { "gt-project-id": args.projectId } : {}),
          },
          body: JSON.stringify({
            sourceLocale,
            targetLocale,
            metadata: {},
            requests,
          }),
        });
      } catch (error) {
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

      if (!response.ok) {
        return {
          ok: false,
          error: `${response.status} ${response.statusText}: translating from ${sourceLocale} to ${targetLocale}`,
        };
      }

      const json = await response.json();
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
          error: `${failures.length} of ${Object.keys(texts).length} translations from ${sourceLocale} to ${targetLocale} failed: ${failures[0]}`,
          translatedTexts: Object.fromEntries(translations),
        };
      }

      return { ok: true, translatedTexts: Object.fromEntries(translations) };
    },
  };
}
