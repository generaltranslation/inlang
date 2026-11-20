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
        "gt-api-version": "2026-03-06.v1",
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
      signal: expect.any(AbortSignal),
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

  test("maps translations back to their keys on 200", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(
        { save: translated("Speichern"), greeting: translated("Hallo") },
        200,
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
  });

  test("names how many texts failed and the first reason, and returns the others", async () => {
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
      scope: "text",
      error: "3 of 4 translations from en to de failed: Translation timed out",
      // not the translation of a text that failed
      translatedTexts: { greeting: "Hallo" },
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

  test.each([
    {
      code: "usage_limit_reached",
      message:
        "Your organization has reached its free usage limit for this month. Configure credit-based billing to continue.",
      error:
        "General Translation rejected the request: Your organization has reached its free usage limit for this month. Configure credit-based billing to continue. Billing settings: https://dash.generaltranslation.com",
    },
    {
      code: "spend_limit_reached",
      message:
        "Your account has reached its billing period spend limit. Increase or remove your spend limit in billing settings to continue using General Translation.",
      error:
        "General Translation rejected the request: Your account has reached its billing period spend limit. Increase or remove your spend limit in billing settings to continue using General Translation. Billing settings: https://dash.generaltranslation.com",
    },
    {
      code: "payment_required",
      // the estimate is this batch's only, not the run's
      message:
        "Your account's credit balance is insufficient to complete this request. Please add more usage credits to your account or configure auto-reload to reload your balance.\n  Available: $0.01\n  Estimated: $0.02",
      error:
        "General Translation rejected the request: Your account's credit balance is insufficient to complete this request. Please add more usage credits to your account or configure auto-reload to reload your balance. Billing settings: https://dash.generaltranslation.com",
    },
  ])(
    "reports a 402 $code with the API's reason",
    async ({ code, message, error }) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        jsonResponse({ error: message, code }, 402),
      );

      const result = await createGtTranslateProvider({
        apiKey: "gtx-dev-key-10",
        userAgent: "inlang-cli/0.0.10",
      }).translateBatch({
        sourceLocale: "en",
        targetLocale: "de",
        texts: { greeting: { text: "Hello" } },
      });

      expect(result).toEqual({ ok: false, error });
    },
  );

  test("reports a key without the Runtime translation permission", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(
        {
          error:
            "API key is missing required permission: project:translations:generate",
        },
        403,
      ),
    );

    const result = await createGtTranslateProvider({
      apiKey: "gtx-api-key-3",
      userAgent: "inlang-cli/0.0.3",
    }).translateBatch({
      sourceLocale: "en",
      targetLocale: "de",
      texts: { greeting: { text: "Hello" } },
    });

    expect(result).toEqual({
      ok: false,
      error:
        "General Translation rejected the request: this API key needs the Runtime translation permission. Edit the key at https://dash.generaltranslation.com.",
    });
  });

  test.each([
    {
      name: "JSON",
      body: JSON.stringify({
        error:
          "Target locale(s) not authorized: de. Please contact support@generaltranslation.com to add them to your project.",
      }),
      error:
        "General Translation rejected the request: Target locale(s) not authorized: de. Please contact support@generaltranslation.com to add them to your project.",
    },
    {
      name: "plain text",
      body: "Key gtx-api-key-4 is blocked\nfrom this network\n",
      error:
        "General Translation rejected the request: Key *** is blocked from this network.",
    },
    {
      name: "text with terminal escapes",
      body: "\x1b]0;title\x07\x1b[2JForbidden!",
      error: "General Translation rejected the request: ]0;title[2JForbidden!",
    },
  ])(
    "reports another 403 with its reason from $name, without the key",
    async ({ body, error }) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(body, { status: 403, statusText: "Forbidden" }),
      );

      const result = await createGtTranslateProvider({
        apiKey: "gtx-api-key-4",
        userAgent: "inlang-cli/0.0.4",
      }).translateBatch({
        sourceLocale: "en",
        targetLocale: "de",
        texts: { greeting: { text: "Hello" } },
      });

      expect(result).toEqual({ ok: false, error });
    },
  );

  test("fails only the texts of a locale the GT project doesn't allow", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(
        {
          error:
            "Target locale(s) not authorized: ja.\nPlease contact support@generaltranslation.com to add them to your project.",
          code: "locale_not_allowed",
        },
        403,
      ),
    );

    const result = await createGtTranslateProvider({
      apiKey: "gtx-api-key-locale",
      userAgent: "inlang-cli/0.0.4",
    }).translateBatch({
      sourceLocale: "en",
      targetLocale: "ja",
      texts: { greeting: { text: "Hello" } },
    });

    expect(result).toEqual({
      ok: false,
      scope: "text",
      error:
        "General Translation rejected the request: Target locale(s) not authorized: ja. Please contact support@generaltranslation.com to add them to your project.",
    });
  });

  test.each([
    {
      name: "an HTML page",
      body: "<!DOCTYPE html><html><body>Forbidden</body></html>",
    },
    { name: "an empty body", body: "" },
    { name: "a body too long to quote", body: "Forbidden. ".repeat(30) },
    { name: "JSON without a reason", body: JSON.stringify({ error: null }) },
  ])("points a 403 with $name to the API key", async ({ body }) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(body, { status: 403, statusText: "Forbidden" }),
    );

    const result = await createGtTranslateProvider({
      apiKey: "gtx-api-key-5",
      userAgent: "inlang-cli/0.0.5",
    }).translateBatch({
      sourceLocale: "en",
      targetLocale: "de",
      texts: { greeting: { text: "Hello" } },
    });

    expect(result).toEqual({
      ok: false,
      error:
        "General Translation rejected the request. Check the API key at https://dash.generaltranslation.com.",
    });
  });

  test("gives up on a 403 whose body doesn't finish", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      status: 403,
      ok: false,
      text: () =>
        Promise.reject(
          new DOMException("The operation timed out.", "TimeoutError"),
        ),
    } as Response);

    const result = await createGtTranslateProvider({
      apiKey: "gtx-api-key-6",
      userAgent: "inlang-cli/0.0.6",
    }).translateBatch({
      sourceLocale: "en",
      targetLocale: "de",
      texts: { greeting: { text: "Hello" } },
    });

    expect(result).toEqual({
      ok: false,
      error: "General Translation didn't answer within 5 minutes.",
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

  test("gives up on a request that doesn't answer", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new DOMException("The operation timed out.", "TimeoutError"),
    );

    const result = await createGtTranslateProvider({
      apiKey: "gtx-dev-key-12",
      userAgent: "inlang-cli/0.0.12",
    }).translateBatch({
      sourceLocale: "en",
      targetLocale: "de",
      texts: { greeting: { text: "Hello" } },
    });

    expect(result).toEqual({
      ok: false,
      error: "General Translation didn't answer within 5 minutes.",
    });
  });

  test("gives up on an answer that doesn't finish", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      status: 201,
      ok: true,
      json: () =>
        Promise.reject(
          new DOMException("The operation timed out.", "TimeoutError"),
        ),
    } as Response);

    const result = await createGtTranslateProvider({
      apiKey: "gtx-dev-key-13",
      userAgent: "inlang-cli/0.0.13",
    }).translateBatch({
      sourceLocale: "en",
      targetLocale: "de",
      texts: { greeting: { text: "Hello" } },
    });

    expect(result).toEqual({
      ok: false,
      error: "General Translation didn't answer within 5 minutes.",
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

  test.each([
    {
      name: "a JSON reason",
      response: () =>
        jsonResponse(
          { error: "Unsupported locale: xx", code: "invalid_request" },
          400,
        ),
      scope: "text",
      error:
        "General Translation answered 400 translating from en to xx: Unsupported locale: xx.",
    },
    {
      name: "a plain-text reason",
      response: () =>
        new Response(
          "Internal server error. If this error persists, contact us!",
          { status: 500, statusText: "Internal Server Error" },
        ),
      scope: "provider",
      error:
        "General Translation answered 500 translating from en to xx: Internal server error. If this error persists, contact us!",
    },
    {
      name: "no reason and an empty status text, as over HTTP/2",
      response: () =>
        new Response("<html><body>Bad Gateway</body></html>", { status: 502 }),
      scope: "provider",
      error: "General Translation answered 502 translating from en to xx.",
    },
    {
      name: "no reason",
      response: () =>
        new Response(null, { status: 413, statusText: "Payload Too Large" }),
      scope: "text",
      error:
        "General Translation answered 413 Payload Too Large translating from en to xx.",
    },
  ])(
    "reports other errors with the locale pair and $name",
    async ({ response, scope, error }) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(response());

      const result = await createGtTranslateProvider({
        apiKey: "gtx-dev-key-12",
        userAgent: "inlang-cli/0.0.12",
      }).translateBatch({
        sourceLocale: "en",
        targetLocale: "xx",
        texts: { greeting: { text: "Hello" } },
      });

      expect(result).toEqual({ ok: false, scope, error });
    },
  );
});

test("a 429 from General Translation is rate-limited, with its Retry-After", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(null, {
      status: 429,
      statusText: "Too Many Requests",
      headers: { "Retry-After": "12" },
    }),
  );
  const result = await createGtTranslateProvider({
    apiKey: "gtx-dev-key",
    userAgent: "inlang-cli/0.0.2",
  }).translateBatch({
    sourceLocale: "en",
    targetLocale: "de",
    texts: { greeting: { text: "Hello" } },
  });
  expect(result).toMatchObject({
    ok: false,
    scope: "provider",
    rateLimited: true,
    retryAfterMs: 12_000,
  });
});
