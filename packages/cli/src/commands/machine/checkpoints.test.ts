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
      return (
        answer(args) ?? {
          ok: true,
          translatedTexts: Object.fromEntries(
            Object.entries(args.texts).map(([key, { text }]) => [
              key,
              `${text} (${args.targetLocale})`,
            ]),
          ),
        }
      );
    },
  };
}

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

test("each locale is saved when it is done, before the next one is requested", async () => {
  const translations = await project(["en", "de", "fr"], ["Hello", "Bye"]);
  const events: string[] = [];
  try {
    const result = await translateCommandAction({
      project: translations,
      provider: provider(events),
      save: async () => {
        events.push(`save ${(await localesOf(translations)).join(",")}`);
      },
    });
    expect(result.translated).toBe(4);
    expect(events).toEqual([
      "request de",
      "save de,en",
      "request fr",
      "save de,en,fr",
    ]);
  } finally {
    await translations.close();
  }
});

test("a provider failure keeps the locales that were saved and requests no other locale", async () => {
  vi.spyOn(log, "warn").mockImplementation(() => undefined);
  const translations = await project(
    ["en", "de", "fr", "es"],
    ["Hello", "Bye"],
  );
  const events: string[] = [];
  try {
    const thrown = await translateCommandAction({
      project: translations,
      provider: provider(events, ({ targetLocale }) =>
        targetLocale === "fr"
          ? { ok: false, error: "503 Service Unavailable", scope: "provider" }
          : undefined,
      ),
      save: async () => void events.push("save"),
    }).catch((error: unknown) => error);

    expect(events).toEqual(["request de", "save", "request fr"]);
    expect(thrown).toBeInstanceOf(MachineTranslateError);
    expect((thrown as MachineTranslateError).translated).toBe(2);
    expect((thrown as Error).message).toBe(
      "503 Service Unavailable\nSaved the 2 translations that came back. Run again to translate the rest.",
    );
    expect(await localesOf(translations)).toEqual(["de", "en"]);
  } finally {
    await translations.close();
  }
});

test("a failed text doesn't stop the later locales, and a locale with nothing translated isn't saved", async () => {
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

    expect(events).toEqual([
      "request de",
      "save",
      "request fr",
      "request es",
      "save",
    ]);
    expect((thrown as Error).message).toBe(
      "400 Bad Request\nSaved the 2 translations that came back. Run again to translate the rest.",
    );
    expect(await localesOf(translations)).toEqual(["de", "en", "es"]);
  } finally {
    await translations.close();
  }
});
