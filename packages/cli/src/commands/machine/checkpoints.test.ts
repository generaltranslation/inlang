import { afterEach, expect, test, vi } from "vitest";
import {
  insertBundleNested,
  loadProjectInMemory,
  newProject,
  selectBundleNested,
} from "@inlang/sdk";
import { translateCommandAction } from "./translate.js";
import { MachineTranslateError } from "./providers/resolveProvider.js";
import { log } from "../../utilities/log.js";
import type {
  BatchMachineTranslateProvider,
  TranslateBatchArgs,
  TranslateBatchResult,
} from "./providers/types.js";

afterEach(() => {
  vi.restoreAllMocks();
});

async function project(locales: string[], texts: string[]) {
  const result = await loadProjectInMemory({
    blob: await newProject({ settings: { baseLocale: "en", locales } }),
  });
  for (const [index, text] of texts.entries()) {
    await insertBundleNested(result.db, {
      id: `b${index}`,
      messages: [
        {
          id: `b${index}_en`,
          bundle_id: `b${index}`,
          locale: "en",
          selectors: [],
          variants: [
            {
              id: `b${index}_en_v`,
              message_id: `b${index}_en`,
              matches: [],
              pattern: [{ type: "text", value: text }],
            },
          ],
        },
      ],
    });
  }
  return result;
}

/** Each text translated into the request's locale. */
function translated(args: TranslateBatchArgs): TranslateBatchResult {
  return {
    ok: true,
    translatedTexts: Object.fromEntries(
      Object.entries(args.texts).map(([key, { text }]) => [
        key,
        `${text} (${args.targetLocale})`,
      ]),
    ),
  };
}

/** Records each request's locale, and answers with `answer` or a translation. */
function provider(
  events: string[],
  answer: (args: TranslateBatchArgs) => TranslateBatchResult | undefined = () =>
    undefined,
): BatchMachineTranslateProvider {
  return {
    supportsContext: true,
    translateBatch: async (args) => {
      events.push(`request ${args.targetLocale}`);
      return answer(args) ?? translated(args);
    },
  };
}

/**
 * Records each request's locale; each request waits until the test answers
 * its locale, with `result` or a translation.
 */
function heldProvider(events: string[]) {
  const held = new Map<string, (result?: TranslateBatchResult) => void>();
  const provider: BatchMachineTranslateProvider = {
    supportsContext: true,
    translateBatch: (args) =>
      new Promise((resolve) => {
        events.push(`request ${args.targetLocale}`);
        held.set(args.targetLocale, (result) =>
          resolve(result ?? translated(args)),
        );
      }),
  };
  const answer = (locale: string, result?: TranslateBatchResult) => {
    const resolve = held.get(locale);
    if (!resolve) throw new Error(`no request for ${locale}`);
    resolve(result);
  };
  return { provider, answer };
}

const requested = (events: string[]) =>
  events.filter((event) => event.startsWith("request")).length;

async function localesOf(
  projectWithBundles: Awaited<ReturnType<typeof project>>,
) {
  const bundles = await selectBundleNested(projectWithBundles.db)
    .selectAll()
    .execute();
  return [
    ...new Set(
      bundles.flatMap((bundle: { messages: Array<{ locale: string }> }) =>
        bundle.messages.map((message) => message.locale),
      ),
    ),
  ].sort();
}

test("the requests of all locales are in flight at once, and each locale is saved as soon as it is done", async () => {
  const translations = await project(
    ["en", "de", "fr", "es"],
    ["Hello", "Bye"],
  );
  const events: string[] = [];
  const { provider, answer } = heldProvider(events);
  try {
    const run = translateCommandAction({
      project: translations,
      provider,
      save: async () => {
        events.push(`save ${(await localesOf(translations)).join(",")}`);
      },
    });
    await vi.waitFor(() => expect(requested(events)).toBe(3));
    answer("fr");
    await vi.waitFor(() => expect(events).toContain("save en,fr"));
    answer("de");
    await vi.waitFor(() => expect(events).toContain("save de,en,fr"));
    answer("es");
    expect((await run).translated).toBe(6);
    expect(events).toEqual([
      "request de",
      "request fr",
      "request es",
      "save en,fr",
      "save de,en,fr",
      "save de,en,es,fr",
    ]);
  } finally {
    await translations.close();
  }
});

test("locales are saved one at a time", async () => {
  const translations = await project(["en", "de", "fr", "es"], ["Hello"]);
  const events: string[] = [];
  let saving = 0;
  let mostAtOnce = 0;
  try {
    const result = await translateCommandAction({
      project: translations,
      provider: provider([]),
      save: async () => {
        mostAtOnce = Math.max(mostAtOnce, ++saving);
        await new Promise((resolve) => setTimeout(resolve, 5));
        events.push(`save ${(await localesOf(translations)).join(",")}`);
        saving--;
      },
    });
    expect(result.translated).toBe(3);
    expect(mostAtOnce).toBe(1);
    expect(events).toEqual([
      "save de,en",
      "save de,en,fr",
      "save de,en,es,fr",
    ]);
  } finally {
    await translations.close();
  }
});

const sixLocales = ["en", "de", "fr", "es", "it", "ja", "ko"];

test("a provider failure sends no other request, and saves what the requests in flight return", async () => {
  vi.spyOn(log, "warn").mockImplementation(() => undefined);
  const translations = await project(sixLocales, ["Hello", "Bye"]);
  const events: string[] = [];
  const { provider, answer } = heldProvider(events);
  try {
    const run = translateCommandAction({
      project: translations,
      provider,
      save: async () => void events.push("save"),
    }).catch((error: unknown) => error);
    // four requests in flight; ja and ko wait for a free one
    await vi.waitFor(() => expect(requested(events)).toBe(4));
    answer("fr", {
      ok: false,
      error: "503 Service Unavailable",
      scope: "provider",
    });
    for (const locale of ["de", "es", "it"]) answer(locale);
    const thrown = await run;

    expect(requested(events)).toBe(4);
    expect(events.filter((event) => event === "save")).toHaveLength(3);
    expect(thrown).toBeInstanceOf(MachineTranslateError);
    expect((thrown as MachineTranslateError).translated).toBe(6);
    expect((thrown as Error).message).toBe(
      "503 Service Unavailable\nSaved the 6 translations that came back. Run again to translate the rest.",
    );
    expect(await localesOf(translations)).toEqual(["de", "en", "es", "it"]);
  } finally {
    await translations.close();
  }
});

test("a failed text doesn't stop the other locales, and a locale with nothing translated isn't saved", async () => {
  const translations = await project(["en", "de", "fr", "es"], ["Hello"]);
  const events: string[] = [];
  try {
    const thrown = await translateCommandAction({
      project: translations,
      provider: provider(events, ({ targetLocale }) =>
        targetLocale === "fr"
          ? { ok: false, error: "400 Bad Request", scope: "text" }
          : undefined,
      ),
      save: async () => void events.push("save"),
    }).catch((error: unknown) => error);

    expect(requested(events)).toBe(3);
    expect(events.filter((event) => event === "save")).toHaveLength(2);
    expect((thrown as Error).message).toBe(
      "400 Bad Request\nSaved the 2 translations that came back. Run again to translate the rest.",
    );
    expect(await localesOf(translations)).toEqual(["de", "en", "es"]);
  } finally {
    await translations.close();
  }
});

test("a stopped run sends no other request, and saves what the requests in flight return", async () => {
  const translations = await project(sixLocales, ["Hello", "Bye"]);
  const events: string[] = [];
  const { provider, answer } = heldProvider(events);
  const stop = new AbortController();
  try {
    const run = translateCommandAction({
      project: translations,
      provider,
      save: async () => void events.push("save"),
      signal: stop.signal,
    }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(requested(events)).toBe(4));
    stop.abort();
    for (const locale of ["de", "fr", "es", "it"]) answer(locale);
    const thrown = await run;

    expect(requested(events)).toBe(4);
    expect(thrown).toBeInstanceOf(MachineTranslateError);
    expect((thrown as Error).message).toBe(
      "Machine translation was stopped.\nSaved the 8 translations that came back. Run again to translate the rest.",
    );
    expect(await localesOf(translations)).toEqual([
      "de",
      "en",
      "es",
      "fr",
      "it",
    ]);
  } finally {
    await translations.close();
  }
});

test("a failed save sends no other request, and saves nothing after it", async () => {
  const translations = await project(sixLocales, ["Hello"]);
  const events: string[] = [];
  const { provider, answer } = heldProvider(events);
  try {
    const run = translateCommandAction({
      project: translations,
      provider,
      save: async () => {
        events.push("save");
        throw new Error("The translations couldn't be saved: disk full");
      },
    }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(requested(events)).toBe(4));
    answer("de");
    await vi.waitFor(() => expect(events).toContain("save"));
    // de's slot took ja before its save failed: requests in flight settle
    const inFlight = events
      .filter((event) => event.startsWith("request "))
      .map((event) => event.slice("request ".length));
    for (const locale of inFlight) if (locale !== "de") answer(locale);
    const thrown = await run;

    expect(inFlight).toEqual(["de", "fr", "es", "it", "ja"]);
    expect(requested(events)).toBe(5);
    expect(events.filter((event) => event === "save")).toHaveLength(1);
    expect((thrown as Error).message).toBe(
      "The translations couldn't be saved: disk full",
    );
  } finally {
    await translations.close();
  }
});

test("a failed save names the locales saved before it", async () => {
  const translations = await project(["en", "de", "fr"], ["Hello"]);
  const events: string[] = [];
  const { provider, answer } = heldProvider(events);
  let saves = 0;
  try {
    const run = translateCommandAction({
      project: translations,
      provider,
      save: async () => {
        if (saves++ > 0) {
          throw new Error("The translations couldn't be saved: disk full");
        }
      },
    }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(requested(events)).toBe(2));
    answer("fr");
    await vi.waitFor(() => expect(saves).toBe(1));
    answer("de");
    const thrown = await run;

    expect(thrown).toBeInstanceOf(MachineTranslateError);
    expect((thrown as Error).message).toBe(
      "The translations couldn't be saved: disk full\nSaved before that: fr. Run again to translate the rest.",
    );
  } finally {
    await translations.close();
  }
});

test("Ctrl+C stops the run and saves what the requests in flight return, and the handler is removed after", async () => {
  vi.spyOn(log, "warn").mockImplementation(() => undefined);
  const translations = await project(sixLocales, ["Hello"]);
  const events: string[] = [];
  const { provider, answer } = heldProvider(events);
  const listeners = process.listenerCount("SIGINT");
  try {
    const run = translateCommandAction({
      project: translations,
      provider,
      save: async () => void events.push("save"),
      stopOnInterrupt: true,
    }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(requested(events)).toBe(4));
    process.emit("SIGINT");
    for (const locale of ["de", "fr", "es", "it"]) answer(locale);
    const thrown = await run;

    expect(requested(events)).toBe(4);
    expect(log.warn).toHaveBeenCalledWith(
      "Stopping: saving the translations that came back. Press Ctrl+C again to quit without saving them.",
    );
    expect((thrown as Error).message).toBe(
      "Machine translation was stopped.\nSaved the 4 translations that came back. Run again to translate the rest.",
    );
    expect(process.listenerCount("SIGINT")).toBe(listeners);
  } finally {
    await translations.close();
  }
});

test("a locale that finishes later doesn't put back the old text of a locale saved before it", async () => {
  const translations = await project(["en", "de", "fr"], []);
  const variant = (locale: string, value: string, text: string) => ({
    id: `items_${locale}_${value}`,
    message_id: `items_${locale}`,
    matches: [
      value === "*"
        ? { type: "catchall-match" as const, key: "countPlural" }
        : { type: "literal-match" as const, key: "countPlural", value },
    ],
    pattern: text ? [{ type: "text" as const, value: text }] : [],
  });
  const message = (
    locale: string,
    variants: ReturnType<typeof variant>[],
  ) => ({
    id: `items_${locale}`,
    bundle_id: "items",
    locale,
    selectors: [{ type: "variable-reference" as const, name: "countPlural" }],
    variants,
  });
  await insertBundleNested(translations.db, {
    id: "items",
    declarations: [
      { type: "input-variable", name: "count" },
      {
        type: "local-variable",
        name: "countPlural",
        value: {
          type: "expression",
          arg: { type: "variable-reference", name: "count" },
          annotation: {
            type: "function-reference",
            name: "plural",
            options: [],
          },
        },
      },
    ],
    // German and French have an empty `one`, which is translated
    messages: [
      message("en", [
        variant("en", "one", "One item"),
        variant("en", "*", "Items"),
      ]),
      message("de", [variant("de", "one", ""), variant("de", "*", "Dinge")]),
      message("fr", [
        variant("fr", "one", ""),
        variant("fr", "*", "Articles"),
      ]),
    ],
  });
  const events: string[] = [];
  const { provider, answer } = heldProvider(events);
  try {
    const run = translateCommandAction({
      project: translations,
      provider,
      save: async () => void events.push("save"),
    });
    await vi.waitFor(() => expect(requested(events)).toBe(2));
    answer("fr");
    await vi.waitFor(() => expect(events).toContain("save"));
    answer("de");
    await run;

    const [bundle] = await selectBundleNested(translations.db)
      .selectAll()
      .execute();
    const forms = (locale: string) =>
      Object.fromEntries(
        bundle.messages
          .find((each: { locale: string }) => each.locale === locale)
          .variants.map(
            (each: {
              matches: Array<{ value?: string }>;
              pattern: Array<{ value: string }>;
            }) => [each.matches[0]!.value ?? "*", each.pattern[0]?.value],
          ),
      );
    expect(forms("fr")).toEqual({ one: "Items (fr)", "*": "Articles" });
    expect(forms("de")).toEqual({ one: "One item (de)", "*": "Dinge" });
  } finally {
    await translations.close();
  }
});
