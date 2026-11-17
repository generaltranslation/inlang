import { afterEach, describe, expect, test, vi } from "vitest";
import { createGtTranslateProvider } from "./gt.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function translated(translation: string) {
  return { success: true, dataFormat: "STRING", translation, locale: "de" };
}

describe("createGtTranslateProvider", () => {
  test("uses context", () => {
    expect(
      createGtTranslateProvider({
        apiKey: "gtx-dev-key-1",
        userAgent: "inlang-cli/0.0.1",
      }).supportsContext,
    ).toBe(true);
  });

  test("sends one request with every text of the batch", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse(
          { greeting: translated("Hallo"), save: translated("Speichern") },
          201,
        ),
      );

    await createGtTranslateProvider({
      apiKey: "gtx-dev-key-2",
      userAgent: "inlang-cli/0.0.2",
    }).translateBatch({
      sourceLocale: "en",
      targetLocale: "de",
      texts: {
        greeting: { text: "Hello" },
        save: { text: "Save", context: "A button label" },
      },
    });

    expect(fetchMock).toHaveBeenCalledWith("https://api.gtx.dev/v2/translate", {
      method: "POST",
      headers: {
        Authorization: "Bearer gtx-dev-key-2",
        "Content-Type": "application/json",
        "User-Agent": "inlang-cli/0.0.2",
      },
      body: JSON.stringify({
        sourceLocale: "en",
        targetLocale: "de",
        metadata: {},
        requests: {
          greeting: { source: "Hello", metadata: { dataFormat: "STRING" } },
          save: {
            source: "Save",
            metadata: { dataFormat: "STRING", context: "A button label" },
          },
        },
      }),
    });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty(
      "gt-project-id",
    );
  });

  test("sends the project id when given", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ greeting: translated("Hallo") }, 201));

    await createGtTranslateProvider({
      apiKey: "gtx-dev-key-project",
      projectId: "prj_test",
      userAgent: "inlang-cli/0.1.0",
    }).translateBatch({
      sourceLocale: "en",
      targetLocale: "de",
      texts: { greeting: { text: "Hello" } },
    });

    expect(fetchMock.mock.calls[0]?.[1]?.headers).toHaveProperty(
      "gt-project-id",
      "prj_test",
    );
  });

  test.each([200, 201])(
    "maps translations back to their keys on %i",
    async (status) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        jsonResponse(
          { save: translated("Speichern"), greeting: translated("Hallo") },
          status,
        ),
      );

      const result = await createGtTranslateProvider({
        apiKey: "gtx-dev-key-3",
        userAgent: "inlang-cli/0.0.3",
      }).translateBatch({
        sourceLocale: "en",
        targetLocale: "de",
        texts: { greeting: { text: "Hello" }, save: { text: "Save" } },
      });

      expect(result).toEqual({
        ok: true,
        translatedTexts: { greeting: "Hallo", save: "Speichern" },
      });
    },
  );

  test("names how many texts failed and the first reason", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(
        {
          greeting: translated("Hallo"),
          save: {
            success: false,
            translation: "Speichern",
            error: "Translation timed out",
            code: 500,
          },
          title: { success: true, dataFormat: "STRING", locale: "de" },
        },
        201,
      ),
    );

    const result = await createGtTranslateProvider({
      apiKey: "gtx-dev-key-6",
      userAgent: "inlang-cli/0.0.6",
    }).translateBatch({
      sourceLocale: "en",
      targetLocale: "de",
      texts: {
        greeting: { text: "Hello" },
        save: { text: "Save" },
        cancel: { text: "Cancel" },
        title: { text: "Title" },
      },
    });

    expect(result).toEqual({
      ok: false,
      error: "3 of 4 translations from en to de failed: Translation timed out",
    });
  });

  test("reports a rejected API key without including it", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        "Unauthorized!\nGet an API key: generaltranslation.com\nOr check our latest documentation: generaltranslation.com/docs",
        { status: 401, statusText: "Unauthorized" },
      ),
    );

    const result = await createGtTranslateProvider({
      apiKey: "gtx-dev-key-7",
      userAgent: "inlang-cli/0.0.7",
    }).translateBatch({
      sourceLocale: "en",
      targetLocale: "de",
      texts: { greeting: { text: "Hello" } },
    });

    expect(result).toEqual({
      ok: false,
      error:
        "General Translation rejected the API key. Get a key from your project at https://dash.generaltranslation.com.",
    });
  });

  test("reports missing credit", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        "<!DOCTYPE html><html><body>Payment Required</body></html>",
        {
          status: 402,
          statusText: "Payment Required",
          headers: { "Content-Type": "text/html" },
        },
      ),
    );

    const result = await createGtTranslateProvider({
      apiKey: "gtx-dev-key-9",
      userAgent: "inlang-cli/0.0.9",
    }).translateBatch({
      sourceLocale: "en",
      targetLocale: "de",
      texts: { greeting: { text: "Hello" } },
    });

    expect(result).toEqual({
      ok: false,
      error:
        "General Translation could not bill this request. Check your billing: https://dash.generaltranslation.com",
    });
  });

  test("reports a network error with its code", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError("fetch failed", {
        cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), {
          code: "ENOTFOUND",
        }),
      }),
    );

    const result = await createGtTranslateProvider({
      apiKey: "gtx-dev-key-11",
      userAgent: "inlang-cli/0.0.11",
    }).translateBatch({
      sourceLocale: "en",
      targetLocale: "de",
      texts: { greeting: { text: "Hello" } },
    });

    expect(result).toEqual({
      ok: false,
      error: "General Translation could not be reached (ENOTFOUND).",
    });
  });

  test("reports a key with a newline without quoting it", async () => {
    const apiKey = "gtx-dev-key-newline\nGT_PROJECT_ID=prj_newline";
    // The message Node's fetch throws for this header value.
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError(
        `Headers.append: "Bearer ${apiKey}" is an invalid header value.`,
      ),
    );

    const result = await createGtTranslateProvider({
      apiKey,
      userAgent: "inlang-cli/0.0.9",
    }).translateBatch({
      sourceLocale: "en",
      targetLocale: "de",
      texts: { greeting: { text: "Hello" } },
    });

    expect(result).toEqual({
      ok: false,
      error:
        "The General Translation API key or project ID contains characters that can't be sent.",
    });
  });

  test("reports other errors with the locale pair", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "Unsupported locale" }), {
        status: 400,
        statusText: "Bad Request",
      }),
    );

    const result = await createGtTranslateProvider({
      apiKey: "gtx-dev-key-12",
      userAgent: "inlang-cli/0.0.12",
    }).translateBatch({
      sourceLocale: "en",
      targetLocale: "xx",
      texts: { greeting: { text: "Hello" } },
    });

    expect(result).toEqual({
      ok: false,
      error: "400 Bad Request: translating from en to xx",
    });
  });
});
