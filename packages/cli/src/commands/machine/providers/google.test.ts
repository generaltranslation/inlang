import { afterEach, describe, expect, test, vi } from "vitest";
import { createGoogleTranslateProvider } from "./google.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createGoogleTranslateProvider", () => {
  test("translates text via Google API", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: { translations: [{ translatedText: "Hallo Welt" }] },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = createGoogleTranslateProvider("google-key");
    const result = await provider.translateText({
      text: "Hello World",
      sourceLocale: "en",
      targetLocale: "de",
    });

    expect(result).toEqual({ ok: true, translatedText: "Hallo Welt" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://translation.googleapis.com/language/translate/v2?" +
        new URLSearchParams({
          q: "Hello World",
          target: "de",
          source: "en",
          format: "html",
          key: "google-key",
        }),
      { method: "POST" },
    );
  });

  test("returns error when API request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        statusText: "Forbidden",
      }),
    );

    const provider = createGoogleTranslateProvider("google-key");
    const result = await provider.translateText({
      text: "Hello World",
      sourceLocale: "en",
      targetLocale: "de",
    });

    expect(result).toEqual({
      ok: false,
      scope: "provider",
      error: "403 Forbidden: translating from en to de",
    });
  });

  // Translation API v2 reports its per-minute quotas as 403, not 429.
  test.each([
    ["userRateLimitExceeded", true],
    ["rateLimitExceeded", true],
    ["dailyLimitExceeded", false],
  ])(
    "a 403 with reason %s is rate-limited: %s",
    async (reason, rateLimited) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 403,
          statusText: "Forbidden",
          headers: new Headers({ "retry-after": "5" }),
          json: async () => ({
            error: { code: 403, errors: [{ domain: "usageLimits", reason }] },
          }),
        }),
      );

      const provider = createGoogleTranslateProvider("google-key");
      const result = await provider.translateText({
        text: "Hello World",
        sourceLocale: "en",
        targetLocale: "de",
      });

      expect(result).toEqual({
        ok: false,
        scope: "provider",
        ...(rateLimited ? { rateLimited: true, retryAfterMs: 5000 } : {}),
        error: "403 Forbidden: translating from en to de",
      });
    },
  );
});
