import { afterEach, test, expect, vi } from "vitest";
import {
  MachineTranslateError,
  translate,
  translateAndSave,
  translateCommandAction,
} from "./translate.js";
import { log } from "../../utilities/log.js";
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
import {
  insertBundleNested,
  loadProjectFromDirectory,
  loadProjectInMemory,
  newProject,
  selectBundleNested,
  type InlangProject,
  type NewBundleNested,
} from "@inlang/sdk";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("skipping the retry waits leaves other timers alone (Lix's close watchdog is 5000 ms)", async () => {
  skipRetryDelay();
  let fired = false;
  const timer = setTimeout(() => (fired = true), 5_000);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(fired).toBe(false);
  clearTimeout(timer);
});

test("requires INLANG_GOOGLE_TRANSLATE_API_KEY", async () => {
  vi.stubEnv("INLANG_MACHINE_TRANSLATE_PROVIDER", "google");
  vi.stubEnv("INLANG_GOOGLE_TRANSLATE_API_KEY", "");

  await expect(translateCommandAction({ project: {} as any })).rejects.toThrow(
    "INLANG_GOOGLE_TRANSLATE_API_KEY must be set",
  );
});

test("requires INLANG_DEEPL_API_KEY when provider is deepl", async () => {
  vi.stubEnv("INLANG_MACHINE_TRANSLATE_PROVIDER", "deepl");
  vi.stubEnv("INLANG_DEEPL_API_KEY", "");

  await expect(translateCommandAction({ project: {} as any })).rejects.toThrow(
    "INLANG_DEEPL_API_KEY must be set",
  );
});

test("requires INLANG_OPENAI_API_KEY when provider is openai", async () => {
  vi.stubEnv("INLANG_MACHINE_TRANSLATE_PROVIDER", "openai");
  vi.stubEnv("INLANG_OPENAI_API_KEY", "");

  await expect(translateCommandAction({ project: {} as any })).rejects.toThrow(
    "INLANG_OPENAI_API_KEY must be set",
  );
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

test("keeps the translations that came back when others fail", async () => {
  vi.stubEnv("INLANG_MACHINE_TRANSLATE_PROVIDER", "demosjarco");
  skipRetryDelay();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async (url: string) => {
      const query = new URL(url).searchParams;
      if (query.get("q") === "Goodbye" || query.get("target") === "fr") {
        return unavailableResponse();
      }
      return Response.json({
        data: {
          translations: [
            { translatedText: `${query.get("q")} (${query.get("target")})` },
          ],
        },
      });
    }),
  );

  const project = await loadProjectInMemory({
    blob: await newProject({
      settings: {
        baseLocale: "en",
        locales: ["en", "de", "fr"],
      },
    }),
  });

  await insertBundleNested(project.db, textBundle("hello", "Hello"));
  await insertBundleNested(project.db, textBundle("goodbye", "Goodbye"));

  const error = await translateCommandAction({ project }).then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(error).toBeInstanceOf(MachineTranslateError);
  expect((error as Error).message).toBe(
    `${SERVICE_UNAVAILABLE_ERROR}\nSaved the 1 translation that came back. Run again to translate the rest.`,
  );
  expect((error as MachineTranslateError).translated).toBe(1);

  const bundles = await selectBundleNested(project.db).execute();
  expect(
    Object.fromEntries(
      bundles.map((bundle) => [
        bundle.id,
        bundle.messages.map((message) => message.locale).sort(),
      ]),
    ),
  ).toEqual({ hello: ["de", "en"], goodbye: ["en"] });
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

/** A project on disk with the message-format plugin and the given message files. */
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
      locales: ["en", "de"],
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
  try {
    await translateAndSave({ project, path });
    expect(fetch).not.toHaveBeenCalled();
    expect(read("en")).toBe(en);
    expect(read("de")).toBe(de);
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

test("saves the translations that came back when one fails", async () => {
  vi.stubEnv("INLANG_MACHINE_TRANSLATE_PROVIDER", "demosjarco");
  skipRetryDelay();
  const en = `{"alpha": "Alpha", "zeta": "Zeta"}`;
  const { project, path, read, cleanup } = await projectOnDisk({
    en,
    de: `{}`,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async (url: string) => {
      const query = new URL(url).searchParams;
      if (query.get("q") === "Zeta") return unavailableResponse();
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
    await expect(translateAndSave({ project, path })).rejects.toBeInstanceOf(
      MachineTranslateError,
    );
    expect(read("en")).toBe(en);
    const de = JSON.parse(read("de"));
    expect(de).toMatchObject({ alpha: "Alpha (de)" });
    expect(de).not.toHaveProperty("zeta");
  } finally {
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

test("at most 4 requests are in flight and none starts after a failure", async () => {
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
    // the first failure is reported
    const error = await run;
    expect(error).toBeInstanceOf(MachineTranslateError);
    expect((error as Error).message).toBe(
      "First failure.\nSaved the 3 translations that came back. Run again to translate the rest.",
    );
    expect(pending).toHaveLength(5);
  } finally {
    await project.close();
  }
});

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

test.each([
  {
    answer: "leaves out a text",
    translatedText: () => undefined,
    // the other two texts came back
    error:
      'No translation was returned for "Text 0".\nSaved the 2 translations that came back. Run again to translate the rest.',
  },
  {
    answer: "has a placeholder that isn't valid",
    translatedText: () => '<span class="notranslate">{broken</span>',
    error: expect.stringMatching(/^SyntaxError: /),
  },
])(
  "a batch answer that $answer fails the run",
  async ({ translatedText, error }) => {
    const project = await projectWithTextBundles(["en", "de"], 3);
    const { provider } = fakeBatchProvider(async (args) => ({
      ok: true,
      translatedTexts: Object.fromEntries(
        Object.entries(args.texts).flatMap(([key, { text }]) => {
          const translation =
            text === "Text 0" ? translatedText() : `${text} (de)`;
          return translation === undefined ? [] : [[key, translation]];
        }),
      ),
    }));
    try {
      const thrown = await translateCommandAction({ project, provider }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(thrown).toBeInstanceOf(MachineTranslateError);
      expect((thrown as Error).message).toEqual(error);
    } finally {
      await project.close();
    }
  },
);

/** Inserts a bundle that has a `de` message but no source message. */
async function insertOrphanBundle(project: InlangProject) {
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
}

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
  await insertOrphanBundle(project);
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

test("plurals the run can't translate are reported once, grouped by locale", async () => {
  const project = await projectWithTextBundles(
    ["en", "ru", "ar", "de", "x-foo"],
    0,
  );
  for (const id of ["cart", "items"]) {
    await insertBundleNested(project.db, pluralBundle(id));
  }
  const warn = vi.spyOn(log, "warn");
  const { provider } = fakeBatchProvider();
  // a provider that uses context gets every form instead
  provider.supportsContext = false;
  try {
    await translateCommandAction({ project, provider });
    expect(warn.mock.calls).toEqual([
      [
        "Some messages were skipped: their plurals need forms the source doesn't have. Add them by hand, then run again.\n" +
          "  ru (few, many): cart, items\n" +
          "  ar (zero, two, few, many): cart, items",
      ],
      ["Plural rules unknown for x-foo; copied the source's forms."],
    ]);
  } finally {
    await project.close();
  }
});

test("with a provider that uses context, every plural form is translated", async () => {
  const project = await projectWithTextBundles(["en", "ru"], 0);
  await insertBundleNested(project.db, pluralBundle("items"));
  const { provider } = fakeBatchProvider();
  try {
    await translateCommandAction({ project, provider });
    const [bundle] = await selectBundleNested(project.db).execute();
    expect(
      bundle!.messages
        .find((message) => message.locale === "ru")!
        .variants.map((variant) =>
          variant.matches[0]!.type === "literal-match"
            ? variant.matches[0]!.value
            : "*",
        ),
    ).toEqual(["one", "few", "many", "*"]);
  } finally {
    await project.close();
  }
});

test("translations that drop a placeholder are reported by locale, the others are written", async () => {
  const project = await projectWithTextBundles(["en", "de", "fr"], 0);
  const name = {
    type: "expression" as const,
    arg: { type: "variable-reference" as const, name: "name" },
  };
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
  const warn = vi.spyOn(log, "warn");
  // drops the placeholder in every German text and in French "Items of"
  const { provider } = fakeBatchProvider(async (args) => ({
    ok: true,
    translatedTexts: Object.fromEntries(
      Object.entries(args.texts).map(([key, { text }]) => [
        key,
        args.targetLocale === "de" || text.startsWith("Items of")
          ? text.replace(/<span class="notranslate">.*?<\/span>/g, "")
          : `${text} (${args.targetLocale})`,
      ]),
    ),
  }));
  try {
    const { translated } = await translateCommandAction({ project, provider });
    expect(translated).toBe(4);
    expect(warn.mock.calls).toEqual([
      [
        "Some translations were reverted: they dropped or changed a placeholder ({name}). Translate them by hand, or run again.\n" +
          "  de: cart, items\n" +
          "  fr: items",
      ],
    ]);
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
      items: ["en"],
      title: ["de", "en", "fr"],
    });
  } finally {
    await project.close();
  }
});
