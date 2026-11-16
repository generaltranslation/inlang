import { afterEach, test, expect, vi } from "vitest";
import {
  MachineTranslateError,
  translateAndSave,
  translateCommandAction,
} from "./translate.js";
import { BYOK_URL } from "./providers/resolveProvider.js";
import type {
  BatchMachineTranslateProvider,
  TranslateBatchArgs,
  TranslateBatchResult,
  TranslateFailure,
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

test("writes no translation when some fail", async () => {
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
  expect((error as Error).message).toBe(SERVICE_UNAVAILABLE_ERROR);

  // hello→de succeeded, but isn't written either
  const bundles = await selectBundleNested(project.db).execute();
  for (const bundle of bundles) {
    expect(bundle.messages.map((message) => message.locale)).toEqual(["en"]);
  }
});

test.each([500, 503])(
  "fails the command when OpenAI returns HTTP %i for every translation",
  async (status) => {
    vi.stubEnv("INLANG_MACHINE_TRANSLATE_PROVIDER", "openai");
    vi.stubEnv("INLANG_OPENAI_API_KEY", "openai-key");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status })),
    );
    const project = await loadProjectInMemory({
      blob: await newProject({
        settings: { baseLocale: "en", locales: ["en", "de"] },
      }),
    });
    try {
      await insertBundleNested(project.db, textBundle("hello", "Hello"));
      await expect(translateCommandAction({ project })).rejects.toBeInstanceOf(
        MachineTranslateError,
      );
      const [bundle] = await selectBundleNested(project.db).execute();
      expect(bundle?.messages.map((message) => message.locale)).toEqual(["en"]);
    } finally {
      await project.close();
    }
  },
);

test.each([500, 503])(
  "writes no OpenAI translation when another locale returns HTTP %i",
  async (status) => {
    vi.stubEnv("INLANG_MACHINE_TRANSLATE_PROVIDER", "openai");
    vi.stubEnv("INLANG_OPENAI_API_KEY", "openai-key");
    // German succeeds before French fails within the same bundle.
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({
            status: "completed",
            output: [
              {
                type: "message",
                status: "completed",
                content: [{ type: "output_text", text: "Hallo" }],
              },
            ],
          }),
        )
        .mockResolvedValueOnce(new Response(null, { status })),
    );
    const project = await loadProjectInMemory({
      blob: await newProject({
        settings: { baseLocale: "en", locales: ["en", "de", "fr"] },
      }),
    });
    try {
      await insertBundleNested(project.db, textBundle("hello", "Hello"));
      const error = await translateCommandAction({ project }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(error).toBeInstanceOf(MachineTranslateError);
      const [bundle] = await selectBundleNested(project.db).execute();
      expect(bundle?.messages.map((message) => message.locale)).toEqual(["en"]);
    } finally {
      await project.close();
    }
  },
);

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

test("writes no file when a translation fails", async () => {
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
    expect(read("de")).toBe(`{}`);
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

/** A promise and the functions that settle it. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Gives a run time to start more requests than it should. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

test("a batch provider gets the texts of every bundle of a locale in requests of at most 50", async () => {
  const project = await projectWithTextBundles(["en", "de"], 120);
  const { provider, calls } = fakeBatchProvider();
  try {
    const { translated } = await translateCommandAction({ project, provider });
    expect(translated).toBe(120);
    expect(calls.map((call) => Object.keys(call.texts).length)).toEqual([
      50, 50, 20,
    ]);
    expect(
      calls.flatMap((call) =>
        Object.values(call.texts).map(({ text }) => text),
      ),
    ).toEqual(
      expect.arrayContaining(
        Array.from({ length: 120 }, (_, index) => `Text ${index}`),
      ),
    );
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
  // answers in the opposite order, by key
  const { provider, calls } = fakeBatchProvider(async (args) => ({
    ok: true,
    translatedTexts: Object.fromEntries(
      Object.entries(args.texts)
        .reverse()
        .map(([key, { text }]) => [key, `${text} (de)`]),
    ),
  }));
  try {
    await translateCommandAction({ project, provider });
    expect(calls[0]?.texts).toEqual({
      hello_en: { text: "Hello", context: "A greeting" },
      bye_en: { text: "Bye" },
    });
    const bundles = await selectBundleNested(project.db).execute();
    const deText = (id: string) =>
      bundles
        .find((bundle) => bundle.id === id)
        ?.messages.find((message) => message.locale === "de")?.variants[0]
        ?.pattern;
    expect(deText("hello")).toEqual([{ type: "text", value: "Hello (de)" }]);
    expect(deText("bye")).toEqual([{ type: "text", value: "Bye (de)" }]);
  } finally {
    await project.close();
  }
});

test.each(["single-text", "batch"] as const)(
  "a %s provider has at most 4 requests in flight and starts none after a failure",
  async (kind) => {
    // 7 requests either way: 7 texts, or 7 batches of 50
    const project = await projectWithTextBundles(
      ["en", "de"],
      kind === "batch" ? 7 * 50 : 7,
    );
    /** Settles a request in flight, successfully or not. */
    const pending: Array<(ok: boolean) => void> = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const request = <T>(success: T) => {
      const { promise, resolve } = deferred<T | TranslateFailure>();
      pending.push((ok) => resolve(ok ? success : { ok: false, error: "x" }));
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return promise.finally(() => inFlight--);
    };
    const provider =
      kind === "batch"
        ? {
            translateBatch: (args: TranslateBatchArgs) =>
              request({
                ok: true as const,
                translatedTexts: Object.fromEntries(
                  Object.keys(args.texts).map((key) => [key, "x"]),
                ),
              }),
          }
        : {
            translateText: () =>
              request({ ok: true as const, translatedText: "x" }),
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
      pending[0]!(true);
      await vi.waitFor(() => expect(pending).toHaveLength(5));
      pending[1]!(false);
      await settle();
      expect(pending).toHaveLength(5);
      for (const settleRequest of pending.slice(2)) settleRequest(true);
      expect(await run).toBeInstanceOf(MachineTranslateError);
      expect(pending).toHaveLength(5);
      expect(maxInFlight).toBe(4);
      const bundles = await selectBundleNested(project.db).execute();
      for (const bundle of bundles) {
        expect(bundle.messages.map((message) => message.locale)).toEqual([
          "en",
        ]);
      }
    } finally {
      await project.close();
    }
  },
);

test("writes no file when one batch request fails", async () => {
  const en = `{"alpha": "Alpha", "zeta": "Zeta"}`;
  const { project, path, read, cleanup } = await projectOnDisk({
    en,
    de: `{}`,
  });
  const { provider } = fakeBatchProvider(async () => ({
    ok: false,
    error: "The batch failed.",
  }));
  try {
    const error = await translateAndSave({ project, path, provider }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(error).toBeInstanceOf(MachineTranslateError);
    expect((error as Error).message).toBe("The batch failed.");
    expect(read("en")).toBe(en);
    expect(read("de")).toBe(`{}`);
  } finally {
    await cleanup();
  }
});

test("a provider without credit says so and that nothing changed", async () => {
  const project = await projectWithTextBundles(["en", "de"], 1);
  const { provider } = fakeBatchProvider(async () => ({
    ok: false,
    error: "402 Payment Required",
    code: "payment-required",
  }));
  try {
    await expect(
      translateCommandAction({ project, provider }),
    ).rejects.toThrowError(
      new MachineTranslateError(
        "Your General Translation account has no credit left, so no files were changed.\n" +
          "Add a card to get $10 of free translation credit: https://dash.generaltranslation.com\n" +
          `Or bring your own key: ${BYOK_URL}`,
      ),
    );
  } finally {
    await project.close();
  }
});
