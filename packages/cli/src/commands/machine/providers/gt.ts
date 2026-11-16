import type {
  BatchMachineTranslateProvider,
  TranslateBatchArgs,
} from "./types.js";

const GT_TRANSLATE_API_URL = "https://api.gtx.dev/v2/translate";

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
            metadata: { dataFormat: "STRING" },
            requests,
          }),
        });
      } catch (error) {
        return {
          ok: false,
          unavailable: true,
          error: `General Translation could not be reached: ${error instanceof Error ? error.message : String(error)}`,
        };
      }

      if (response.status === 401) {
        // The body is plain text that only says "Unauthorized!".
        return {
          ok: false,
          code: "unauthorized",
          error:
            "General Translation rejected the API key. Get a key from your project at https://dash.generaltranslation.com.",
        };
      }

      if (response.status === 402) {
        // The body is either JSON with the reason or an HTML page.
        const reason = await readJsonError(response);
        return {
          ok: false,
          code: "payment-required",
          error: `General Translation could not bill this request${reason ? `: ${reason}` : "."}`,
        };
      }

      if (response.status === 429 || response.status >= 500) {
        return {
          ok: false,
          unavailable: true,
          error: `General Translation is not available (${response.status} ${response.statusText}).`,
        };
      }

      if (!response.ok) {
        return {
          ok: false,
          error: `${response.status} ${response.statusText}: translating from ${sourceLocale} to ${targetLocale}`,
        };
      }

      const json = await response.json();
      const translatedTexts: Record<string, string> = {};
      const failures: string[] = [];
      for (const key of Object.keys(texts)) {
        const result = json?.[key];
        if (
          result?.success === true &&
          typeof result.translation === "string"
        ) {
          translatedTexts[key] = result.translation;
        } else {
          failures.push(result?.error ?? "no translation was returned");
        }
      }

      if (failures.length > 0) {
        return {
          ok: false,
          error: `${failures.length} of ${Object.keys(texts).length} translations from ${sourceLocale} to ${targetLocale} failed: ${failures[0]}`,
        };
      }

      return { ok: true, translatedTexts };
    },
  };
}

async function readJsonError(response: Response): Promise<string | undefined> {
  try {
    const json = await response.json();
    return typeof json?.error === "string" ? json.error : undefined;
  } catch {
    return undefined;
  }
}
