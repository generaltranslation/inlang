import { afterEach, beforeEach, test, expect, vi } from "vitest";
import {
  translate,
  translateAndSave,
  translateCommandAction,
} from "./translate.js";
import { log } from "../../utilities/log.js";
import { MachineTranslateError } from "./providers/resolveProvider.js";
import type {
  BatchMachineTranslateProvider,
  TranslateBatchArgs,
  TranslateBatchResult,
  TranslateFailure,
  TranslateTextResult,
} from "./providers/types.js";
import {
  retryWait,
  SERVICE_UNAVAILABLE_ERROR,
} from "./providers/demosjarco.js";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { createRequire } from "node:module";
import progressBar from "cli-progress";
import {
  insertBundleNested,
  loadProjectFromDirectory,
  loadProjectInMemory,
  newProject,
  selectBundleNested,
  type NewBundleNested,
} from "@inlang/sdk";

const BYOK_URL = "https://inlang.com/m/2qj2w8pu/app-inlang-cli/byok";

let providerDirectory: string;
beforeEach(() => {
  providerDirectory = fs.mkdtempSync(
    nodePath.join(os.tmpdir(), "inlang-command-env-"),
  );
  const opts = translate.opts.bind(translate);
  vi.spyOn(translate, "opts").mockImplementation(() => {
    const options = opts();
    return {
      ...options,
      project:
        options.project ?? nodePath.join(providerDirectory, "project.inlang"),
    };
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fs.rmSync(providerDirectory, { recursive: true, force: true });
});

test("skipping the retry waits leaves other timers alone (Lix's close watchdog is 5000 ms)", async () => {
  skipRetryDelay();
  let fired = false;
  const timer = setTimeout(() => (fired = true), 5_000);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(fired).toBe(false);
  clearTimeout(timer);
});

function unavailableResponse() {
  return new Response(null, {
    status: 503,
    statusText: "Service Unavailable",
  });
}

/** Skips the provider's retry waits so retries don't slow the test down; other timers keep their delays. */
function skipRetryDelay() {
  vi.spyOn(retryWait, "sleep").mockResolvedValue();
}

function textBundle(id: string, text: string): NewBundleNested {
  return {
    id,
    messages: [
      {
        id: `${id}_en`,
        bundle_id: id,
        locale: "en",
        variants: [
          {
            id: `${id}_en`,
            message_id: `${id}_en`,
            pattern: [{ type: "text" as const, value: text }],
          },
        ],
      },
    ],
  };
}

test("fails with a non-zero-triggering error when the fallback service is completely unavailable", async () => {
  vi.stubEnv("INLANG_MACHINE_TRANSLATE_PROVIDER", "demosjarco");
  skipRetryDelay();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async () => unavailableResponse()),
  );

  const project = await loadProjectInMemory({
    blob: await newProject({
      settings: {
        baseLocale: "en",
        locales: ["en", "de"],
      },
    }),
  });

  await insertBundleNested(project.db, {
    id: "mock",
    messages: [
      {
        id: "mock_en",
        bundle_id: "mock",
        locale: "en",
        variants: [
          {
            id: "mock_en",
            message_id: "mock_en",
            pattern: [{ type: "text", value: "Hello World" }],
          },
        ],
      },
    ],
  });

  await expect(translateCommandAction({ project })).rejects.toThrow(
    "translate.demosjarco.dev is not available",
  );
});

test.runIf(process.env.INLANG_GOOGLE_TRANSLATE_API_KEY)(
  "should tanslate the missing languages",
  async () => {
    vi.stubEnv("INLANG_MACHINE_TRANSLATE_PROVIDER", "google");

    const project = await loadProjectInMemory({
      blob: await newProject({
        settings: {
          baseLocale: "en",
          locales: ["en", "de"],
        },
      }),
    });

    await insertBundleNested(project.db, {
      id: "mock",
      messages: [
        {
          id: "mock_en",
          bundle_id: "mock",
          locale: "en",
          variants: [
            {
              id: "mock_en",
              message_id: "mock_en",
              pattern: [{ type: "text", value: "Hello World" }],
            },
          ],
        },
      ],
    });

    await translateCommandAction({ project });

    const bundles = await selectBundleNested(project.db).execute();
    const messages = bundles[0]?.messages;
    const variants = messages?.flatMap((m) => m.variants);

    expect(bundles.length).toBe(1);
    expect(messages?.length).toBe(2);
    expect(variants?.length).toBe(2);

    expect(bundles[0]?.id).toBe("mock");
    expect(messages?.find((m) => m.locale === "en")).toBeDefined();
    expect(messages?.find((m) => m.locale === "de")).toBeDefined();
    expect(variants).toStrictEqual([
      expect.objectContaining({
        pattern: [
          {
            type: "text",
            value: "Hello World",
          },
        ],
      }),
      expect.objectContaining({
        pattern: [
          {
            type: "text",
            value: "Hallo Welt",
          },
        ],
      }),
    ]);
  },
  { timeout: 10000 },
);

test.runIf(process.env.INLANG_DEEPL_API_KEY)(
  "should translate missing languages with DeepL",
  async () => {
    vi.stubEnv("INLANG_MACHINE_TRANSLATE_PROVIDER", "deepl");

    const project = await loadProjectInMemory({
      blob: await newProject({
        settings: {
          baseLocale: "en",
          locales: ["en", "de"],
        },
      }),
    });

    await insertBundleNested(project.db, {
      id: "mock",
      messages: [
        {
          id: "mock_en",
          bundle_id: "mock",
          locale: "en",
          variants: [
            {
              id: "mock_en",
              message_id: "mock_en",
              pattern: [{ type: "text", value: "Hello World" }],
            },
          ],
        },
      ],
    });

    await translateCommandAction({ project });

    const bundles = await selectBundleNested(project.db).execute();
    const messages = bundles[0]?.messages;
    const variants = messages?.flatMap((m) => m.variants);

    expect(bundles.length).toBe(1);
    expect(messages?.length).toBe(2);
    expect(variants?.length).toBe(2);

    expect(bundles[0]?.id).toBe("mock");
    expect(messages?.find((m) => m.locale === "en")).toBeDefined();
    expect(messages?.find((m) => m.locale === "de")).toBeDefined();
    expect(variants).toStrictEqual([
      expect.objectContaining({
        pattern: [
          {
            type: "text",
            value: "Hello World",
          },
        ],
      }),
      expect.objectContaining({
        pattern: [
          {
            type: "text",
            value: "Hallo Welt",
          },
        ],
      }),
    ]);
  },
  { timeout: 10000 },
);

/** A project on disk with the message-format plugin and a message file per locale. */
async function projectOnDisk(messages: Record<string, string>) {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "inlang-translate-"));
  const path = nodePath.join(root, "project.inlang");
  fs.mkdirSync(nodePath.join(path, "plugins"), { recursive: true });
  fs.copyFileSync(
    createRequire(import.meta.url).resolve("@inlang/plugin-message-format"),
    nodePath.join(path, "plugins/message-format.js"),
  );
  fs.writeFileSync(
    nodePath.join(path, "settings.json"),
    JSON.stringify({
      baseLocale: "en",
      locales: Object.keys(messages),
      modules: ["./project.inlang/plugins/message-format.js"],
      "plugin.inlang.messageFormat": {
        pathPattern: "./messages/{locale}.json",
      },
    }),
  );
  fs.mkdirSync(nodePath.join(root, "messages"));
  for (const [locale, content] of Object.entries(messages))
    fs.writeFileSync(nodePath.join(root, `messages/${locale}.json`), content);
  const project = await loadProjectFromDirectory({ path, fs });
  const read = (locale: string) =>
    fs.readFileSync(nodePath.join(root, `messages/${locale}.json`), "utf8");
  return {
    project,
    path,
    read,
    cleanup: async () => {
      await project.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("doesn't rewrite translation files when nothing was translated", async () => {
  vi.stubEnv("INLANG_MACHINE_TRANSLATE_PROVIDER", "demosjarco");
  // formatting the exporter wouldn't reproduce: key order, spacing, no trailing newline
  const en = `{"zeta": "Zeta",   "alpha": "Alpha"}`;
  const de = `{\n    "alpha": "Alpha (de)",\n    "zeta": "Zeta (de)"\n}`;
  const { project, path, read, cleanup } = await projectOnDisk({ en, de });
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const success = vi.spyOn(log, "success");
  try {
    await translateAndSave({ project, path });
    expect(fetch).not.toHaveBeenCalled();
    expect(read("en")).toBe(en);
    expect(read("de")).toBe(de);
    expect(success).toHaveBeenCalledTimes(1);
  } finally {
    await cleanup();
  }
});

test("writes the translation files when something was translated", async () => {
  vi.stubEnv("INLANG_MACHINE_TRANSLATE_PROVIDER", "demosjarco");
  const { project, path, read, cleanup } = await projectOnDisk({
    en: `{"alpha": "Alpha", "zeta": "Zeta"}`,
    de: `{"alpha": "Alpha (de)"}`,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async (url: string) => {
      const query = new URL(url).searchParams;
      return Response.json({
        data: {
          translations: [
            { translatedText: `${query.get("q")} (${query.get("target")})` },
          ],
        },
      });
    }),
  );
  try {
    await translateAndSave({ project, path });
    expect(JSON.parse(read("de"))).toMatchObject({
      alpha: "Alpha (de)",
      zeta: "Zeta (de)",
    });
  } finally {
    await cleanup();
  }
});

test("only the translated messages change in the translation files", async () => {
  vi.stubEnv("INLANG_MACHINE_TRANSLATE_PROVIDER", "demosjarco");
  // formatting the exporter wouldn't reproduce: key order, spacing, escapes,
  // no $schema, no trailing newline
  const en = `{"zeta": "Zeta",   "alpha": "Alpha", "beta": "Beta"}`;
  const de = `{\n    "zeta": "Zeta (de)",\n    "alpha":"Caf\\u00e9"\n}`;
  const { project, path, read, cleanup } = await projectOnDisk({ en, de });
  const fetch = vi.fn().mockImplementation(async (url: string) => {
    const query = new URL(url).searchParams;
    return Response.json({
      data: {
        translations: [
          { translatedText: `${query.get("q")} (${query.get("target")})` },
        ],
      },
    });
  });
  vi.stubGlobal("fetch", fetch);
  try {
    await translateAndSave({ project, path });
    // only beta was translated
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(new URL(fetch.mock.calls[0]![0]).searchParams.get("q")).toBe("Beta");
    expect(read("en")).toBe(en);
    expect(read("de")).toBe(
      `{\n    "zeta": "Zeta (de)",\n    "alpha":"Caf\\u00e9",\n    "beta":"Beta (de)"\n}`,
    );
  } finally {
    await cleanup();
  }
});

test("a failed save fails the run, without claiming success", async () => {
  vi.stubEnv("INLANG_MACHINE_TRANSLATE_PROVIDER", "demosjarco");
  const { project, path, read, cleanup } = await projectOnDisk({
    en: `{"alpha": "Alpha"}`,
    de: `{}`,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async (url: string) => {
      const query = new URL(url).searchParams;
      return Response.json({
        data: {
          translations: [
            { translatedText: `${query.get("q")} (${query.get("target")})` },
          ],
        },
      });
    }),
  );
  const success = vi.spyOn(log, "success");
  const de = nodePath.join(path, "../messages/de.json");
  fs.chmodSync(de, 0o444);
  try {
    await expect(translateAndSave({ project, path })).rejects.toThrow(
      /^The translations couldn't be saved: .*EACCES/,
    );
    expect(success).not.toHaveBeenCalled();
    expect(read("de")).toBe(`{}`);
  } finally {
    fs.chmodSync(de, 0o644);
    await cleanup();
  }
});

test("a bundle gets a locale only with all its translations", async () => {
  vi.stubEnv("INLANG_MACHINE_TRANSLATE_PROVIDER", "demosjarco");
  skipRetryDelay();
  const plural = `[{"declarations": ["input count", "local countPlural = count: plural"], "selectors": ["countPlural"], "match": {"countPlural=one": "One item", "countPlural=*": "Many items"}}]`;
  const { project, path, read, cleanup } = await projectOnDisk({
    en: `{"items": ${plural}, "alpha": "Alpha"}`,
    de: `{}`,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async (url: string) => {
      const query = new URL(url).searchParams;
      if (query.get("q") === "Many items") return unavailableResponse();
      return Response.json({
        data: {
          translations: [
            { translatedText: `${query.get("q")} (${query.get("target")})` },
          ],
        },
      });
    }),
  );
  try {
    await expect(translateAndSave({ project, path })).rejects.toThrow(
      "Saved the 1 translation that came back.",
    );
    // "One item (de)" came back too, but without the catch-all it would
    // match nothing
    const de = JSON.parse(read("de"));
    expect(de).toMatchObject({ alpha: "Alpha (de)" });
    expect(de).not.toHaveProperty("items");
  } finally {
    await cleanup();
  }
});

test("a translated plural form goes before the existing catch-all, other entries stay byte-identical", async () => {
  vi.stubEnv("INLANG_MACHINE_TRANSLATE_PROVIDER", "demosjarco");
  const plural = (match: string) =>
    `[{"declarations": ["input count", "local countPlural = count: plural"], "selectors": ["countPlural"], "match": {${match}}}]`;
  const en = `{\n  "items": ${plural('"countPlural=one": "One item", "countPlural=*": "Many items"')},\n  "alpha": "Alpha"\n}\n`;
  // only the catch-all; odd formatting that the exporter wouldn't reproduce
  const de = `{\n  "alpha":   "Alpha (de)",\n  "items": ${plural('"countPlural=*": "Viele Dinge"')}\n}\n`;
  const { project, path, read, cleanup } = await projectOnDisk({ en, de });
  const fetch = vi.fn().mockImplementation(async (url: string) => {
    const query = new URL(url).searchParams;
    return Response.json({
      data: {
        translations: [
          { translatedText: `${query.get("q")} (${query.get("target")})` },
        ],
      },
    });
  });
  vi.stubGlobal("fetch", fetch);
  try {
    await translateAndSave({ project, path });
    expect(fetch).toHaveBeenCalledTimes(1);

    const after = read("de");
    expect(after.startsWith(`{\n  "alpha":   "Alpha (de)",\n`)).toBe(true);
    expect(Object.keys(JSON.parse(after).items[0].match)).toEqual([
      "countPlural=one",
      "countPlural=*",
    ]);
    expect(JSON.parse(after).items[0].match["countPlural=*"]).toBe(
      "Viele Dinge",
    );
    expect(read("en")).toBe(en);
    // one variant per form in the project, in the order of the file
    const [bundle] = (await selectBundleNested(project.db).execute()).filter(
      (bundle) => bundle.id === "items",
    );
    const deMessage = bundle!.messages.find((m) => m.locale === "de")!;
    expect(
      deMessage.variants.map((variant) => variant.matches[0]!.type),
    ).toEqual(["literal-match", "catchall-match"]);

    // nothing left to translate: the files stay as they are
    await translateAndSave({ project, path });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(read("de")).toBe(after);
  } finally {
    await cleanup();
  }
});

/** A batch provider that records its calls and translates `text` to `text (locale)`. */
function fakeBatchProvider(
  translateBatch: (
    args: TranslateBatchArgs,
  ) => Promise<TranslateBatchResult> = async (args) => ({
    ok: true,
    translatedTexts: Object.fromEntries(
      Object.entries(args.texts).map(([key, { text }]) => [
        key,
        `${text} (${args.targetLocale})`,
      ]),
    ),
  }),
) {
  const calls: TranslateBatchArgs[] = [];
  const provider: BatchMachineTranslateProvider = {
    supportsContext: true,
    translateBatch: (args) => {
      calls.push(args);
      return translateBatch(args);
    },
  };
  return { provider, calls };
}

async function projectWithTextBundles(locales: string[], count: number) {
  const project = await loadProjectInMemory({
    blob: await newProject({ settings: { baseLocale: "en", locales } }),
  });
  for (let index = 0; index < count; index++) {
    await insertBundleNested(
      project.db,
      textBundle(`bundle${index}`, `Text ${index}`),
    );
  }
  return project;
}

/** Gives a run time to start more requests than it should. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

test("a batch provider gets the texts of every bundle of a locale in requests of at most 50", async () => {
  const project = await projectWithTextBundles(["en", "de"], 120);
  const { provider, calls } = fakeBatchProvider();
  try {
    await translateCommandAction({ project, provider });
    expect(calls.map((call) => Object.keys(call.texts).length)).toEqual([
      50, 50, 20,
    ]);
  } finally {
    await project.close();
  }
});

test("a batch provider gets one request per locale", async () => {
  const project = await projectWithTextBundles(["en", "de", "fr"], 2);
  const { provider, calls } = fakeBatchProvider();
  try {
    await translateCommandAction({ project, provider });
    expect(
      calls.map((call) => [
        call.sourceLocale,
        call.targetLocale,
        Object.values(call.texts).map(({ text }) => text),
      ]),
    ).toEqual([
      ["en", "de", ["Text 0", "Text 1"]],
      ["en", "fr", ["Text 0", "Text 1"]],
    ]);
  } finally {
    await project.close();
  }
});

test("batch translations go to the variants their keys name", async () => {
  const project = await loadProjectInMemory({
    blob: await newProject({
      settings: { baseLocale: "en", locales: ["en", "de"] },
    }),
  });
  await insertBundleNested(project.db, {
    ...textBundle("hello", "Hello"),
    description: "A greeting",
  });
  await insertBundleNested(project.db, textBundle("bye", "Bye"));
  await insertBundleNested(project.db, {
    ...textBundle("empty", "Empty"),
    description: "",
  });
  const { provider, calls } = fakeBatchProvider();
  try {
    await translateCommandAction({ project, provider });
    // no context for a missing or an empty description
    expect(calls[0]?.texts).toEqual({
      "0": { text: "Bye" },
      "1": { text: "Empty" },
      "2": { text: "Hello", context: "A greeting" },
    });
    const bundles = await selectBundleNested(project.db).execute();
    const deText = (id: string) =>
      bundles
        .find((bundle) => bundle.id === id)
        ?.messages.find((message) => message.locale === "de")?.variants[0]
        ?.pattern;
    expect(deText("hello")).toEqual([{ type: "text", value: "Hello (de)" }]);
    expect(deText("bye")).toEqual([{ type: "text", value: "Bye (de)" }]);
    expect(deText("empty")).toEqual([{ type: "text", value: "Empty (de)" }]);
  } finally {
    await project.close();
  }
});

test("a blank translation is missing unless its source is blank too", async () => {
  const project = await projectWithTextBundles(["en", "de"], 0);
  const withGerman = (id: string, en: string, de: string): NewBundleNested => {
    const bundle = textBundle(id, en);
    return {
      ...bundle,
      messages: [
        ...bundle.messages,
        {
          id: `${id}_de`,
          bundle_id: id,
          locale: "de",
          variants: [
            {
              id: `${id}_de`,
              message_id: `${id}_de`,
              pattern: [{ type: "text", value: de }],
            },
          ],
        },
      ],
    };
  };
  // `inlang check` reports both as empty translations
  await insertBundleNested(project.db, withGerman("blank", "Hello", " \n "));
  await insertBundleNested(project.db, withGerman("both", " ", ""));
  const { provider, calls } = fakeBatchProvider();
  try {
    await translateCommandAction({ project, provider });
    expect(
      calls.flatMap((call) =>
        Object.values(call.texts).map(({ text }) => text),
      ),
    ).toEqual(["Hello"]);
  } finally {
    await project.close();
  }
});

test("at most 4 requests are in flight and provider failures stop new requests", async () => {
  const project = await projectWithTextBundles(["en", "de"], 7);
  /** Settles a request in flight, successfully or not. */
  const pending: Array<(failure?: TranslateFailure) => void> = [];
  const provider = {
    translateText: () =>
      new Promise<TranslateTextResult>((resolve) =>
        pending.push((failure) =>
          resolve(failure ?? { ok: true, translatedText: "x" }),
        ),
      ),
  };
  try {
    const run = translateCommandAction({ project, provider }).then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(pending).toHaveLength(4));
    await settle();
    expect(pending).toHaveLength(4);
    // a finished request makes room for one more
    pending[0]!();
    await vi.waitFor(() => expect(pending).toHaveLength(5));
    pending[1]!({ ok: false, error: "First failure." });
    await settle();
    expect(pending).toHaveLength(5);
    // a request in flight that fails after the first failure
    pending[2]!({ ok: false, error: "Another failure." });
    for (const settleRequest of pending.slice(3)) settleRequest();
    // failures already in flight are reported too
    const error = await run;
    expect(error).toBeInstanceOf(MachineTranslateError);
    expect((error as Error).message).toBe(
      "First failure.\nAnother failure.\nSaved the 3 translations that came back. Run again to translate the rest.",
    );
    expect(pending).toHaveLength(5);
  } finally {
    await project.close();
  }
});

test("a permanent text error cannot starve messages behind an incomplete new message", async () => {
  vi.stubEnv("INLANG_MACHINE_TRANSLATE_PROVIDER", "google");
  vi.stubEnv("INLANG_GOOGLE_TRANSLATE_API_KEY", "test-key");
  const { project, path, read, cleanup } = await projectOnDisk({
    en: JSON.stringify({
      a_blocker: [
        {
          declarations: ["input tone"],
          selectors: ["tone"],
          match: {
            "tone=a": "Bad",
            "tone=b": "B",
            "tone=c": "C",
            "tone=*": "D",
          },
        },
      ],
      b_after: "After B",
      c_after: "After C",
    }),
    de: "{}",
  });
  const fetch = vi.fn(async (url: string) => {
    const text = new URL(url).searchParams.get("q");
    if (text === "Bad")
      return new Response(null, { status: 400, statusText: "Bad Request" });
    // The bad text fails while the other three forms occupy the workers.
    await new Promise((resolve) => setTimeout(resolve, 10));
    return Response.json({
      data: { translations: [{ translatedText: `${text} (de)` }] },
    });
  });
  vi.stubGlobal("fetch", fetch);
  try {
    await expect(translateAndSave({ project, path })).rejects.toThrow(
      "400 Bad Request",
    );
    expect(fetch).toHaveBeenCalledTimes(6);
    expect(JSON.parse(read("de"))).toMatchObject({
      b_after: "After B (de)",
      c_after: "After C (de)",
    });
    expect(JSON.parse(read("de")).a_blocker).toBeUndefined();
    const saved = read("de");
    const reopened = await loadProjectFromDirectory({ path, fs });
    fetch.mockClear();
    try {
      await expect(
        translateAndSave({ project: reopened, path }),
      ).rejects.toThrow("400 Bad Request");
      expect(fetch).toHaveBeenCalledTimes(4);
      expect(read("de")).toBe(saved);
    } finally {
      await reopened.close();
    }
  } finally {
    await cleanup();
  }
});

test.each(["failed", "missing"] as const)(
  "a %s batch item does not stop batches beyond the initial four requests",
  async (failure) => {
    const project = await projectWithTextBundles(["en", "de"], 251);
    const { provider, calls } = fakeBatchProvider(async (args) => {
      const translatedTexts = Object.fromEntries(
        Object.entries(args.texts)
          .filter(([, { text }]) => text !== "Text 0")
          .map(([key, { text }]) => [key, `${text} (de)`]),
      );
      return failure === "failed" &&
        Object.values(args.texts).some(({ text }) => text === "Text 0")
        ? {
            ok: false,
            scope: "text",
            error: "Model refused Text 0",
            translatedTexts,
          }
        : { ok: true, translatedTexts };
    });
    try {
      await expect(
        translateCommandAction({ project, provider }),
      ).rejects.toThrow("Saved the 250 translations");
      expect(calls).toHaveLength(6);
      const bundles = await selectBundleNested(project.db).execute();
      expect(
        bundles.filter((bundle) =>
          bundle.messages.some((message) => message.locale === "de"),
        ),
      ).toHaveLength(250);
      expect(
        bundles
          .find((bundle) => bundle.id === "bundle0")
          ?.messages.map((message) => message.locale),
      ).toEqual(["en"]);
    } finally {
      await project.close();
    }
  },
);

test("a thrown error fails the run like a returned one", async () => {
  const project = await projectWithTextBundles(["en", "de"], 1);
  const provider = {
    translateText: async (): Promise<TranslateTextResult> => {
      throw new TypeError("fetch failed");
    },
  };
  try {
    await expect(
      translateCommandAction({ project, provider }),
    ).rejects.toThrowError(
      new MachineTranslateError("TypeError: fetch failed"),
    );
  } finally {
    await project.close();
  }
});

test("a batch answer with a placeholder that isn't one fails the run, keeping the others", async () => {
  const project = await projectWithTextBundles(["en", "de"], 3);
  const { provider } = fakeBatchProvider(async (args) => ({
    ok: true,
    translatedTexts: Object.fromEntries(
      Object.entries(args.texts).map(([key, { text }]) => [
        key,
        text === "Text 0"
          ? '<span class="notranslate">null</span>'
          : `${text} (de)`,
      ]),
    ),
  }));
  try {
    await expect(translateCommandAction({ project, provider })).rejects.toThrow(
      "SyntaxError: Not a placeholder: null\nSaved the 2 translations that came back. Run again to translate the rest.",
    );
  } finally {
    await project.close();
  }
});

test("a failed batch keeps the texts it did translate", async () => {
  const project = await projectWithTextBundles(["en", "de"], 3);
  const { provider } = fakeBatchProvider(async (args) => ({
    ok: false,
    error: "1 of 3 translations failed: model refused",
    translatedTexts: Object.fromEntries(
      Object.entries(args.texts)
        .filter(([, { text }]) => text !== "Text 0")
        .map(([key, { text }]) => [key, `${text} (de)`]),
    ),
  }));
  try {
    const thrown = await translateCommandAction({ project, provider }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(MachineTranslateError);
    expect((thrown as Error).message).toBe(
      "1 of 3 translations failed: model refused\nSaved the 2 translations that came back. Run again to translate the rest.",
    );
    const bundles = await selectBundleNested(project.db).execute();
    expect(
      Object.fromEntries(
        bundles.map((bundle) => [
          bundle.id,
          bundle.messages.map((message) => message.locale).sort(),
        ]),
      ),
    ).toEqual({
      bundle0: ["en"],
      bundle1: ["de", "en"],
      bundle2: ["de", "en"],
    });
  } finally {
    await project.close();
  }
});

test("a bundle without a source message is reported when a translation fails", async () => {
  const project = await projectWithTextBundles(["en", "de"], 1);
  // a bundle with a `de` message but no source message
  await insertBundleNested(project.db, {
    id: "orphan",
    messages: [
      {
        id: "orphan_de",
        bundle_id: "orphan",
        locale: "de",
        variants: [
          {
            id: "orphan_de",
            message_id: "orphan_de",
            pattern: [{ type: "text", value: "Waise" }],
          },
        ],
      },
    ],
  });
  const warn = vi.spyOn(log, "warn");
  const { provider } = fakeBatchProvider(async () => ({
    ok: false,
    error: "The batch failed.",
  }));
  try {
    await expect(
      translateCommandAction({ project, provider }),
    ).rejects.toThrowError(MachineTranslateError);
    expect(warn).toHaveBeenCalledWith("Some bundles could not be translated.");
  } finally {
    await project.close();
  }
});

test("the command prints a translation failure as is and exits with 1", async () => {
  vi.stubEnv("INLANG_MACHINE_TRANSLATE_PROVIDER", "demosjarco");
  skipRetryDelay();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async () => unavailableResponse()),
  );
  const { path, cleanup } = await projectOnDisk({
    en: `{"alpha": "Alpha"}`,
    de: `{}`,
  });
  const error = vi.spyOn(log, "error");
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation(() => undefined as never);
  try {
    await translate.parseAsync(["--project", path, "--nobar"], {
      from: "user",
    });
    expect(error.mock.calls).toEqual([[SERVICE_UNAVAILABLE_ERROR]]);
    expect(exit).toHaveBeenCalledWith(1);
  } finally {
    await cleanup();
  }
});

/** A bundle with an English `one` and `*` of the plural `countPlural`. */
function pluralBundle(id: string): NewBundleNested {
  const variant = (value: string, text: string) => ({
    id: `${id}_en_${value}`,
    message_id: `${id}_en`,
    matches: [
      value === "*"
        ? { type: "catchall-match" as const, key: "countPlural" }
        : { type: "literal-match" as const, key: "countPlural", value },
    ],
    pattern: [{ type: "text" as const, value: text }],
  });
  return {
    id,
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
    messages: [
      {
        id: `${id}_en`,
        bundle_id: id,
        locale: "en",
        selectors: [{ type: "variable-reference", name: "countPlural" }],
        variants: [variant("one", "One item"), variant("*", "Items")],
      },
    ],
  };
}

test("plurals that need forms the source lacks get the source's forms and are reported once, grouped by locale", async () => {
  const project = await projectWithTextBundles(
    ["en", "ru", "ar", "de", "x-foo"],
    0,
  );
  for (const id of ["cart", "items"]) {
    await insertBundleNested(project.db, pluralBundle(id));
  }
  const warn = vi.spyOn(log, "warn");
  // Google doesn't use context; a provider that does gets every form instead
  clearProviderEnv();
  vi.stubEnv("INLANG_GOOGLE_TRANSLATE_API_KEY", "google-key");
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({
      data: { translations: [{ translatedText: "Übersetzt" }] },
    }),
  );
  try {
    await translateCommandAction({ project });
    expect(warn.mock.calls).toEqual([
      [
        "Some plurals lack forms their language needs; add them by hand:\n" +
          "  ru (few, many): cart, items\n" +
          "  ar (zero, two, few, many): cart, items\n" +
          "Until then, whether those numbers fall back to another form depends on the message format: i18next, for example, shows the message key.\n" +
          "General Translation writes every form a language needs: https://inlang.com/m/2qj2w8pu/app-inlang-cli#machine-translate",
      ],
      ["Plural rules unknown for x-foo; copied the source's forms."],
    ]);
    // translated as before these were reported, rather than left out
    const bundles = await selectBundleNested(project.db).selectAll().execute();
    for (const bundle of bundles) {
      for (const locale of ["ru", "ar"]) {
        expect(
          bundle.messages.find(
            (message: { locale: string }) => message.locale === locale,
          )?.variants,
        ).toHaveLength(2);
      }
    }
  } finally {
    await project.close();
  }
});

test("General Translation, the default provider, gets every plural form", async () => {
  clearProviderEnv();
  vi.stubEnv("GT_API_KEY", "gt-key");
  // translates each text to itself
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_, init) => {
    const { requests } = JSON.parse(String(init!.body));
    return Response.json(
      Object.fromEntries(
        Object.entries<{ source: string }>(requests).map(([key, request]) => [
          key,
          { success: true, translation: request.source },
        ]),
      ),
    );
  });
  vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  const { path, read, cleanup } = await projectOnDisk({
    en: `{"items": [{"declarations": ["input count", "local countPlural = count: plural"], "selectors": ["countPlural"], "match": {"countPlural=one": "One item", "countPlural=*": "Items"}}]}`,
    ru: `{}`,
  });
  try {
    await translate.parseAsync(["--project", path, "--nobar"], {
      from: "user",
    });
    expect(Object.keys(JSON.parse(read("ru")).items[0].match)).toEqual([
      "countPlural=one",
      "countPlural=few",
      "countPlural=many",
      "countPlural=*",
    ]);
  } finally {
    await cleanup();
  }
});

/** `{name}` as a placeholder of a pattern. */
const name = {
  type: "expression" as const,
  arg: { type: "variable-reference" as const, name: "name" },
};

/** Removes the placeholders the provider gets as `notranslate` spans. */
const dropPlaceholders = (text: string) =>
  text.replace(/<span class="notranslate">[^<]*<\/span>/g, "");

test("rejected translations are reported by bundle and locale, the others are saved, and the run fails", async () => {
  const project = await projectWithTextBundles(["en", "de", "fr"], 0);
  // a plural with two forms and a text, each using {name}
  const cart = pluralBundle("cart");
  cart.declarations!.push({ type: "input-variable", name: "name" });
  const items = textBundle("items", "Items of ");
  for (const variant of [
    ...cart.messages[0]!.variants,
    ...items.messages[0]!.variants,
  ]) {
    variant.pattern!.push(name);
  }
  await insertBundleNested(project.db, cart);
  await insertBundleNested(project.db, items);
  await insertBundleNested(project.db, textBundle("title", "Title"));
  // drops the placeholders in German, and French "Title" comes back empty
  const { provider } = fakeBatchProvider(async (args) => ({
    ok: true,
    translatedTexts: Object.fromEntries(
      Object.entries(args.texts).map(([key, { text }]) => [
        key,
        args.targetLocale === "de"
          ? dropPlaceholders(text)
          : text === "Title"
            ? ""
            : `${text} (${args.targetLocale})`,
      ]),
    ),
  }));
  try {
    const thrown = await translateCommandAction({ project, provider }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect((thrown as Error).message).toBe(
      "Some translations weren't saved: they came back empty, or their placeholders don't match the source's:\n" +
        "  de: cart ({name}), items ({name})\n" +
        "  fr: title (empty)\n" +
        "Saved the 4 translations that came back intact. Run again to translate the rest.",
    );
    const bundles = await selectBundleNested(project.db).execute();
    expect(
      Object.fromEntries(
        bundles.map((bundle) => [
          bundle.id,
          bundle.messages.map((message) => message.locale).sort(),
        ]),
      ),
    ).toEqual({
      cart: ["en", "fr"],
      items: ["en", "fr"],
      title: ["de", "en"],
    });
  } finally {
    await project.close();
  }
});

/**
 * Unsets every variable that selects a provider, including GT keys such as
 * `VITE_GT_DEV_API_KEY` from the developer's shell, which would otherwise
 * reach General Translation's API.
 */
function clearProviderEnv() {
  for (const name of Object.keys(process.env)) {
    if (/^INLANG_|GT_(DEV_)?API_KEY$|GT_PROJECT_ID$/.test(name))
      vi.stubEnv(name, "");
  }
}

test.each([
  { stdinTTY: false, stdoutTTY: true, ci: "", asks: false },
  { stdinTTY: true, stdoutTTY: false, ci: "", asks: false },
  { stdinTTY: true, stdoutTTY: true, ci: "", asks: true },
  { stdinTTY: true, stdoutTTY: true, ci: "1", asks: false },
])(
  "unconfigured runs translate unattended and ask only at a terminal (%o)",
  async ({ stdinTTY, stdoutTTY, ci, asks }) => {
    clearProviderEnv();
    vi.stubEnv("CI", ci);
    vi.stubEnv("DISPLAY", undefined);
    vi.stubEnv("WAYLAND_DISPLAY", undefined);
    const restoreTTY = [
      stubIsTTY(process.stdin, stdinTTY),
      stubIsTTY(process.stdout, stdoutTTY),
    ];
    // Ctrl+C or Esc at the sign-in question, which consola's types leave out
    const prompt = vi
      .spyOn(log, "prompt")
      .mockResolvedValue(undefined as never);
    vi.spyOn(log, "log").mockImplementation(() => undefined);
    const fetch = vi.fn().mockImplementation(async () =>
      Response.json({
        data: { translations: [{ translatedText: "Alpha DE" }] },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const { path, read, cleanup } = await projectOnDisk({
      en: `{"alpha": "Alpha"}`,
      de: `{}`,
    });
    const root = nodePath.dirname(path);
    vi.stubEnv("PATH", nodePath.join(root, "no-npx"));
    const error = vi.spyOn(log, "error");
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      await translate.parseAsync(["--project", path, "--nobar"], {
        from: "user",
      });
      expect(prompt).toHaveBeenCalledTimes(asks ? 1 : 0);
      expect(exit).toHaveBeenCalledWith(asks ? 1 : 0);
      const requests = fetch.mock.calls.filter(([url]) =>
        String(url).startsWith("https://"),
      );
      if (asks) {
        expect(error.mock.calls).toEqual([
          [
            `No translation provider. Run again to sign in to General Translation, or bring your own key: ${BYOK_URL}`,
          ],
        ]);
        expect(requests).toEqual([]);
        expect(JSON.parse(read("de"))).toEqual({});
      } else {
        expect(error).not.toHaveBeenCalled();
        expect(requests).toHaveLength(1);
        expect(String(requests[0]![0])).toMatch(
          /^https:\/\/translate\.demosjarco\.dev\//,
        );
        expect(JSON.parse(read("de"))).toMatchObject({ alpha: "Alpha DE" });
        expect(fs.existsSync(nodePath.join(root, ".env.local"))).toBe(false);
        expect(fs.existsSync(nodePath.join(root, "gt.config.json"))).toBe(
          false,
        );
      }
    } finally {
      Object.defineProperty(process, "platform", platform);
      for (const restore of restoreTTY) restore();
      await cleanup();
    }
  },
);

function stubIsTTY(
  stream: NodeJS.ReadStream | NodeJS.WriteStream,
  value: boolean,
) {
  const original = Object.getOwnPropertyDescriptor(stream, "isTTY");
  Object.defineProperty(stream, "isTTY", { value, configurable: true });
  return () => {
    if (original) Object.defineProperty(stream, "isTTY", original);
    else delete (stream as { isTTY?: boolean }).isTTY;
  };
}

test("a run with nothing to translate needs no provider and reports what it skipped", async () => {
  // would fail for the missing key if the provider were resolved
  vi.stubEnv("INLANG_MACHINE_TRANSLATE_PROVIDER", "google");
  vi.stubEnv("INLANG_GOOGLE_TRANSLATE_API_KEY", "");
  const project = await projectWithTextBundles(["en", "ru"], 0);
  // a Russian plural of an English text, skipped instead of expanded
  const items = textBundle("items", "Items");
  const {
    declarations,
    messages: [plural],
  } = pluralBundle("plural");
  await insertBundleNested(project.db, {
    ...items,
    declarations,
    messages: [
      ...items.messages,
      { ...plural!, bundle_id: "items", locale: "ru" },
    ],
  });
  const warn = vi.spyOn(log, "warn");
  try {
    expect(await translateCommandAction({ project })).toEqual({
      translated: 0,
      bundles: 1,
    });
    expect(warn.mock.calls).toEqual([
      [
        "Some plurals lack forms their language needs; add them by hand:\n" +
          "  ru (few, many): items\n" +
          "Until then, whether those numbers fall back to another form depends on the message format: i18next, for example, shows the message key.",
      ],
    ]);
  } finally {
    await project.close();
  }
});

test("a failed request and rejected translations are reported in one error", async () => {
  const project = await projectWithTextBundles(["en", "de"], 2);
  const items = textBundle("items", "Items of ");
  items.messages[0]!.variants[0]!.pattern!.push(name);
  await insertBundleNested(project.db, items);
  const { provider } = fakeBatchProvider(async (args) => ({
    ok: false,
    error: "1 of 3 translations failed: model refused",
    translatedTexts: Object.fromEntries(
      Object.entries(args.texts)
        .filter(([, { text }]) => text !== "Text 0")
        .map(([key, { text }]) => [key, `${dropPlaceholders(text)} (de)`]),
    ),
  }));
  try {
    const thrown = await translateCommandAction({ project, provider }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect((thrown as Error).message).toBe(
      "1 of 3 translations failed: model refused\n" +
        "Some translations weren't saved: they came back empty, or their placeholders don't match the source's:\n" +
        "  de: items ({name})\n" +
        "Saved the 1 translation that came back intact. Run again to translate the rest.",
    );
  } finally {
    await project.close();
  }
});

test("a provider without context that finds nothing to translate starts no translation", async () => {
  // Russian needs forms the English plural lacks: missing with context. It
  // has the source's forms, all a provider without context could add.
  const project = await projectWithTextBundles(["en", "ru"], 0);
  const bundle = pluralBundle("items");
  const [en] = bundle.messages;
  await insertBundleNested(project.db, {
    ...bundle,
    description: "How many items are in the cart",
    messages: [
      en!,
      {
        ...en!,
        id: "items_ru",
        locale: "ru",
        variants: en!.variants.map((variant) => ({
          ...variant,
          id: `${variant.id}_ru`,
          message_id: "items_ru",
          pattern: [{ type: "text" as const, value: "Товары" }],
        })),
      },
    ],
  });
  const start = vi.spyOn(progressBar.SingleBar.prototype, "start");
  const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
  const { provider, calls } = fakeBatchProvider();
  try {
    expect(
      await translateCommandAction({
        project,
        provider: { ...provider, supportsContext: false },
      }),
    ).toEqual({ translated: 0, bundles: 1 });
    expect(start).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    // Only the incomplete plural, not that descriptions aren't used.
    expect(warn.mock.calls).toEqual([
      [
        "Some plurals lack forms their language needs; add them by hand:\n" +
          "  ru (few, many): items\n" +
          "Until then, whether those numbers fall back to another form depends on the message format: i18next, for example, shows the message key.\n" +
          "General Translation writes every form a language needs: https://inlang.com/m/2qj2w8pu/app-inlang-cli#machine-translate",
      ],
    ]);
  } finally {
    await project.close();
  }
});

test.each([
  {
    supportsContext: false,
    description: "A greeting on the home page",
    warnings: [
      [
        "The selected translation provider doesn't use bundle descriptions as context.",
      ],
    ],
  },
  {
    supportsContext: true,
    description: "A greeting on the home page",
    warnings: [],
  },
])(
  "warns only when the provider ignores bundle descriptions (supportsContext: $supportsContext, description: $description)",
  async ({ supportsContext, description, warnings }) => {
    const project = await projectWithTextBundles(["en", "de"], 0);
    await insertBundleNested(project.db, {
      ...textBundle("hello", "Hello"),
      description,
    });
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const { provider } = fakeBatchProvider();
    try {
      await translateCommandAction({
        project,
        provider: { ...provider, supportsContext },
      });
      expect(warn.mock.calls).toEqual(warnings);
    } finally {
      await project.close();
    }
  },
);
