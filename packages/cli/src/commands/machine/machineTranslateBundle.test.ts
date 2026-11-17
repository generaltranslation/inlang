import { expect, test } from "vitest";
import {
  matchValue,
  type BundleNested,
  type Declaration,
  type NewBundleNested,
  type Pattern,
} from "@inlang/sdk";
import { planBundleTranslation } from "./machineTranslateBundle.js";
import { machineTranslateBundle } from "./machineTranslateBundle.test-util.js";
import type { TranslateBatchArgs } from "./providers/types.js";

test("translated variants get ids in the order of the source variants", async () => {
  const values = Array.from({ length: 20 }, (_, index) => `v${index}`);
  const bundle: BundleNested = {
    id: "bundle",
    declarations: [],
    messages: [
      {
        id: "en",
        bundleId: "bundle",
        locale: "en",
        selectors: [{ type: "variable-reference", name: "n" }],
        variants: values.map((value) => ({
          id: `en-${value}`,
          messageId: "en",
          matches: [{ type: "literal-match", key: "n", value }],
          pattern: [{ type: "text", value }],
        })),
      },
    ],
  } as any;

  const result = await machineTranslateBundle({
    bundle,
    sourceLocale: "en",
    targetLocales: ["de"],
    provider: {
      translateText: async ({ text }) => ({
        ok: true,
        translatedText: `${text} (de)`,
      }),
    },
  });

  const de = result.data!.messages.find((message) => message.locale === "de")!;
  // variants are ordered by id: the source order
  const ids = de.variants.map((variant) => variant.id!);
  expect([...ids].sort()).toEqual(ids);
  expect(de.variants.map((variant) => variant.matches)).toEqual(
    bundle.messages[0]!.variants.map((variant) => variant.matches),
  );
});

const provider = {
  translateText: async ({ text }: { text: string }) => ({
    ok: true as const,
    translatedText: `${text} (de)`,
  }),
};

/** uuid v7 ids, like the database creates, in this order */
const v7Ids: Record<string, string> = Object.fromEntries(
  ["en-one", "en-*", "de-one", "de-few", "de-*"].map((name, index) => [
    name,
    `01900000-0000-7000-8000-00000000000${index}`,
  ]),
);

/** A plural bundle: en has `one` and `*`, de has the given variants. */
function pluralBundle(
  de: Array<[string, string]>,
  idOf: (name: string) => string = (name) => v7Ids[name]!,
): BundleNested {
  const variant = (message: string, value: string, text: string) => ({
    id: idOf(`${message}-${value}`),
    messageId: message,
    message_id: message,
    matches:
      value === "*"
        ? [{ type: "catchall-match", key: "countPlural" }]
        : [{ type: "literal-match", key: "countPlural", value }],
    pattern: [{ type: "text", value: text }],
  });
  return {
    id: "items",
    declarations: [],
    messages: [
      {
        id: "en",
        bundleId: "items",
        locale: "en",
        selectors: [{ type: "variable-reference", name: "countPlural" }],
        variants: [
          variant("en", "one", "One item"),
          variant("en", "*", "Many items"),
        ],
      },
      {
        id: "de",
        bundleId: "items",
        locale: "de",
        selectors: [{ type: "variable-reference", name: "countPlural" }],
        variants: de.map(([value, text]) => variant("de", value, text)),
      },
    ],
  } as any;
}

const valuesOf = (message: { variants: Array<{ matches?: any[] }> }) =>
  message.variants.map((variant) =>
    variant.matches![0].type === "catchall-match"
      ? "*"
      : variant.matches![0].value,
  );

test("a translated variant goes to its place in the source message", async () => {
  const bundle = pluralBundle([["*", "Viele Dinge"]]);
  const result = await machineTranslateBundle({
    bundle,
    sourceLocale: "en",
    targetLocales: ["de"],
    provider,
  });

  const de = result.data!.messages.find((m) => m.locale === "de")!;
  expect(valuesOf(de)).toEqual(["one", "*"]);
  // the existing catch-all keeps its text and gets an id after `one`
  expect(de.variants[1]!.pattern).toEqual([
    { type: "text", value: "Viele Dinge" },
  ]);
  const ids = de.variants.map((variant) => variant.id!);
  expect([...ids].sort()).toEqual(ids);
  expect(ids).not.toContain(v7Ids["de-*"]);
  expect(result.replacedVariantIds).toEqual([v7Ids["de-*"]]);
});

test("variants already in order keep their ids", async () => {
  const bundle = pluralBundle([["one", "Ein Ding"]]);
  const result = await machineTranslateBundle({
    bundle,
    sourceLocale: "en",
    targetLocales: ["de"],
    provider,
  });

  const de = result.data!.messages.find((m) => m.locale === "de")!;
  expect(valuesOf(de)).toEqual(["one", "*"]);
  expect(de.variants[0]!.id).toBe(v7Ids["de-one"]);
  expect(de.variants[0]!.id! < de.variants[1]!.id!).toBe(true);
  expect(result.replacedVariantIds).toBeUndefined();
});

test("an id that a new variant doesn't sort after is replaced", async () => {
  // e.g. an id an app chose
  const bundle = pluralBundle([["one", "Ein Ding"]], (name) => name);
  const result = await machineTranslateBundle({
    bundle,
    sourceLocale: "en",
    targetLocales: ["de"],
    provider,
  });

  const de = result.data!.messages.find((m) => m.locale === "de")!;
  expect(valuesOf(de)).toEqual(["one", "*"]);
  const ids = de.variants.map((variant) => variant.id!);
  expect([...ids].sort()).toEqual(ids);
  expect(de.variants[0]!.pattern).toEqual([
    { type: "text", value: "Ein Ding" },
  ]);
  expect(result.replacedVariantIds).toEqual(["de-one"]);
});

test("a variant the source doesn't have stays after the one it followed", async () => {
  // e.g. Polish `few`, which English doesn't have
  const bundle = pluralBundle([
    ["few", "Kilka"],
    ["*", "Wiele"],
  ]);
  const result = await machineTranslateBundle({
    bundle,
    sourceLocale: "en",
    targetLocales: ["de"],
    provider,
  });

  const de = result.data!.messages.find((m) => m.locale === "de")!;
  expect(valuesOf(de)).toEqual(["few", "one", "*"]);
  // `few` keeps its id, the ones after it get new ones
  expect(de.variants[0]!.id).toBe(v7Ids["de-few"]);
  expect(result.replacedVariantIds).toEqual([v7Ids["de-*"]]);
});

test("an empty variant is filled and the variants keep the source order", async () => {
  const bundle = pluralBundle([["*", ""]]);
  const result = await machineTranslateBundle({
    bundle,
    sourceLocale: "en",
    targetLocales: ["de"],
    provider: {
      translateBatch: async () => ({
        ok: true,
        translatedTexts: { "0": "Ein Ding", "1": "Viele Dinge" },
      }),
    },
  });

  const de = result.data!.messages.find((m) => m.locale === "de")!;
  expect(valuesOf(de)).toEqual(["one", "*"]);
  // the empty catch-all is filled in
  expect(de.variants.map((variant) => variant.pattern)).toEqual([
    [{ type: "text", value: "Ein Ding" }],
    [{ type: "text", value: "Viele Dinge" }],
  ]);
});

test("a target locale given twice is translated once", async () => {
  const texts: string[] = [];
  const result = await machineTranslateBundle({
    bundle: pluralBundle([]),
    sourceLocale: "en",
    targetLocales: ["de", "de"],
    provider: {
      translateText: async ({ text }) => {
        texts.push(text);
        return { ok: true, translatedText: `${text} (de)` };
      },
    },
  });

  expect(texts).toEqual(["One item", "Many items"]);
  const de = result.data!.messages.find((m) => m.locale === "de")!;
  expect(valuesOf(de)).toEqual(["one", "*"]);
});

const input = (name: string): Declaration => ({ type: "input-variable", name });

/** `local <name> = <arg>: plural <options>`; an option value `$x` is a variable. */
const plural = (
  name: string,
  arg: string,
  options: Record<string, string> = {},
): Declaration => ({
  type: "local-variable",
  name,
  value: {
    type: "expression",
    arg: { type: "variable-reference", name: arg },
    annotation: {
      type: "function-reference",
      name: "plural",
      options: Object.entries(options).map(([name, value]) => ({
        name,
        value: value.startsWith("$")
          ? { type: "variable-reference", name: value.slice(1) }
          : { type: "literal", value },
      })),
    },
  },
});

const countPlural = [input("count"), plural("countPlural", "count")];

/**
 * A bundle with a message per locale. Forms are keyed by their matches,
 * `"countPlural=one,gender=*"`, or `""` for a message without selectors.
 */
function formsBundle(
  declarations: Declaration[],
  selectors: string[],
  messages: Record<string, Record<string, string>>,
): BundleNested {
  return {
    id: "items",
    declarations,
    messages: Object.entries(messages).map(([locale, forms]) => ({
      id: locale,
      bundleId: "items",
      locale,
      selectors: selectors.map((name) => ({
        type: "variable-reference",
        name,
      })),
      variants: Object.entries(forms).map(([key, text], index) => ({
        id: `01900000-0000-7000-8000-${locale.padStart(6, "0")}${String(index).padStart(6, "0")}`,
        messageId: locale,
        matches: (key === "" ? [] : key.split(",")).map((pair) => {
          const [key, value] = pair.split("=") as [string, string];
          return value === "*"
            ? { type: "catchall-match", key }
            : { type: "literal-match", key, value };
        }),
        pattern: text === "" ? [] : [{ type: "text", value: text }],
      })),
    })),
  } as any;
}

/** A provider that records its calls and translates `text` to `[locale] text`. */
function recordingProvider(supportsContext: boolean) {
  const calls: Array<{ text: string; targetLocale: string; context?: string }> =
    [];
  return {
    calls,
    provider: {
      supportsContext,
      translateText: async (args: {
        text: string;
        targetLocale: string;
        context?: string;
      }) => {
        calls.push({
          text: args.text,
          targetLocale: args.targetLocale,
          context: args.context,
        });
        return {
          ok: true as const,
          translatedText: `[${args.targetLocale}] ${args.text}`,
        };
      },
    },
  };
}

/** The forms of a locale's message, keyed like `formsBundle`'s. */
function formsOf(result: { data?: NewBundleNested }, locale: string) {
  const message = result.data!.messages.find((m) => m.locale === locale);
  return (
    message &&
    Object.fromEntries(
      message.variants.map((variant) => [
        variant
          .matches!.map(
            (match) =>
              `${match.key}=${match.type === "literal-match" ? match.value : "*"}`,
          )
          .join(","),
        textOf(variant.pattern!),
      ]),
    )
  );
}

async function translate(
  bundle: BundleNested,
  targetLocales: string[],
  supportsContext = false,
) {
  const { calls, provider } = recordingProvider(supportsContext);
  const args = { bundle, sourceLocale: "en", targetLocales };
  const plan = planBundleTranslation({ ...args, supportsContext });
  if ("error" in plan) throw new Error(plan.error);
  const result = await machineTranslateBundle({ ...args, provider });
  expectReachable(bundle, result.data!);
  return { calls, result: { ...plan, ...result } };
}

/**
 * Fails if a variant with a new id (added, or moved by `orderLikeSource`)
 * can never show: a consumer that reads variants in stored order (Paraglide
 * before 2.27) selects the first variant whose every key is the input's or a
 * catch-all.
 */
function expectReachable(before: BundleNested, after: NewBundleNested) {
  const ids = new Set(
    before.messages.flatMap((message) => message.variants.map(({ id }) => id)),
  );
  for (const { variants } of (after as BundleNested).messages) {
    variants.forEach((variant, index) => {
      if (ids.has(variant.id)) return;
      const shadowing = variants
        .slice(0, index)
        .filter((earlier) =>
          variant.matches.every(({ key }) =>
            ["*", matchValue(variant, key)].includes(matchValue(earlier, key)),
          ),
        );
      expect(shadowing).toEqual([]);
    });
  }
}

const items = { "countPlural=one": "One item", "countPlural=*": "Many items" };

test("a locale whose plurals need forms the source doesn't have is skipped, others are translated", async () => {
  const bundle = formsBundle(countPlural, ["countPlural"], { en: items });
  const { calls, result } = await translate(bundle, ["ru", "de"]);

  expect(result.skippedPlurals).toEqual([
    { locale: "ru", categories: ["few", "many"] },
  ]);
  // no request and no message for ru
  expect(calls.map((call) => call.targetLocale)).toEqual(["de", "de"]);
  expect(formsOf(result, "ru")).toBeUndefined();
  expect(formsOf(result, "de")).toEqual({
    "countPlural=one": "[de] One item",
    "countPlural=*": "[de] Many items",
  });
});

test("two plurals: a category in any combination of the source counts for the other plural", async () => {
  const bundle = formsBundle(
    [...countPlural, input("guests"), plural("guestsPlural", "guests")],
    ["countPlural", "guestsPlural"],
    {
      en: {
        "countPlural=one,guestsPlural=one": "One item for one guest",
        "countPlural=*,guestsPlural=*": "Items for guests",
      },
    },
  );
  const { result } = await translate(bundle, ["ru"]);

  // Russian `one` × `few` has a source for `one`: `one` × `one`
  expect(result.skippedPlurals).toEqual([
    { locale: "ru", categories: ["few", "many"] },
  ]);
});

test("a target complete for one gender is skipped when another lacks a category", async () => {
  const bundle = formsBundle(
    [input("gender"), ...countPlural],
    ["countPlural", "gender"],
    {
      en: {
        "countPlural=one,gender=female": "She has one item",
        "countPlural=*,gender=female": "She has items",
        "countPlural=one,gender=*": "They have one item",
        "countPlural=*,gender=*": "They have items",
      },
      ru: {
        "countPlural=one,gender=*": "У них один товар",
        "countPlural=few,gender=*": "У них несколько товаров",
        "countPlural=many,gender=*": "У них много товаров",
        "countPlural=*,gender=*": "У них товары",
      },
    },
  );
  const { calls, result } = await translate(bundle, ["ru"]);

  // `female` is the source's
  expect(result.skippedPlurals).toEqual([
    { locale: "ru", categories: ["few", "many"] },
  ]);
  expect(calls).toEqual([]);
});

test("a select value only the target has needs no category", async () => {
  const bundle = formsBundle(
    [input("gender"), ...countPlural],
    ["countPlural", "gender"],
    {
      en: {
        "countPlural=one,gender=*": "They have one item",
        "countPlural=*,gender=*": "They have items",
      },
      de: { "countPlural=*,gender=diverse": "Sie haben Dinge" },
    },
  );
  const { calls, result } = await translate(bundle, ["de"]);

  // German lacks `one` × `diverse`, as English does
  expect(result.skippedPlurals).toEqual([]);
  expect(calls.map((call) => call.text)).toEqual([
    "They have one item",
    "They have items",
  ]);
});

test("a target with its own plural forms is translated: only the empty catch-all", async () => {
  const bundle = formsBundle(countPlural, ["countPlural"], {
    en: items,
    ru: {
      "countPlural=one": "Один товар",
      "countPlural=few": "Несколько товаров",
      "countPlural=many": "Много товаров",
      "countPlural=*": "",
    },
  });
  const { calls, result } = await translate(bundle, ["ru"]);

  expect(result.skippedPlurals).toEqual([]);
  expect(calls).toEqual([
    { text: "Many items", targetLocale: "ru", context: undefined },
  ]);
  expect(formsOf(result, "ru")).toEqual({
    "countPlural=one": "Один товар",
    "countPlural=few": "Несколько товаров",
    "countPlural=many": "Много товаров",
    "countPlural=*": "[ru] Many items",
  });
});

test("empty forms are missing forms: a target whose plural forms are all empty is skipped", async () => {
  const bundle = formsBundle(countPlural, ["countPlural"], {
    en: items,
    ru: {
      "countPlural=one": "",
      "countPlural=few": "",
      "countPlural=many": "",
      "countPlural=*": "",
    },
  });
  const { calls, result } = await translate(bundle, ["ru"]);

  expect(result.skippedPlurals).toEqual([
    { locale: "ru", categories: ["few", "many"] },
  ]);
  expect(calls).toEqual([]);
});

test("a target's own selectors decide the forms it needs", async () => {
  // a source without a plural, and a hand-written Russian plural without
  // `many` and a catch-all
  const bundle = formsBundle(countPlural, ["countPlural"], {
    en: { "countPlural=*": "Items" },
    ru: {
      "countPlural=one": "Один товар",
      "countPlural=few": "Несколько товаров",
    },
  });
  const en = bundle.messages.find((message) => message.locale === "en")!;
  en.selectors = [];
  en.variants[0]!.matches = [];
  const { calls, result } = await translate(bundle, ["ru"]);

  expect(result.skippedPlurals).toEqual([
    { locale: "ru", categories: ["many"] },
  ]);
  expect(calls).toEqual([]);
});

test("`other` and the catch-all are the same form", async () => {
  // the source's catch-all is the target's `other`: no second one is added,
  // and the translated `one` goes before `other`
  const catchAll = await translate(
    formsBundle(countPlural, ["countPlural"], {
      en: items,
      de: { "countPlural=other": "Dinge" },
    }),
    ["de"],
  );
  expect(catchAll.calls.map((call) => call.text)).toEqual(["One item"]);
  expect(Object.entries(formsOf(catchAll.result, "de")!)).toEqual([
    ["countPlural=one", "[de] One item"],
    ["countPlural=other", "Dinge"],
  ]);

  // an empty `other` is filled, not left next to a second catch-all
  const emptyOther = await translate(
    formsBundle(countPlural, ["countPlural"], {
      en: items,
      de: { "countPlural=one": "Ein Ding", "countPlural=other": "" },
    }),
    ["de"],
  );
  expect(emptyOther.calls.map((call) => call.text)).toEqual(["Many items"]);
  expect(Object.entries(formsOf(emptyOther.result, "de")!)).toEqual([
    ["countPlural=one", "Ein Ding"],
    ["countPlural=other", "[de] Many items"],
  ]);
});

test("a source with both `other` and the catch-all keeps both", async () => {
  // a select's `other` is a value like any other
  const gender = [input("gender")];
  const selectOther = await translate(
    formsBundle(gender, ["gender"], {
      en: { "gender=female": "She", "gender=*": "They" },
      de: { "gender=female": "Sie", "gender=other": "Andere" },
    }),
    ["de"],
  );
  expect(selectOther.calls.map((call) => call.text)).toEqual(["They"]);

  // on a plural, `other` stands in for the catch-all only when the source lacks one
  const pluralForms = {
    "countPlural=one": "One item",
    "countPlural=other": "Items",
    "countPlural=*": "Some items",
  };
  const partialPlural = await translate(
    formsBundle(countPlural, ["countPlural"], {
      en: pluralForms,
      de: { "countPlural=one": "Ein Ding", "countPlural=other": "Dinge" },
    }),
    ["de"],
  );
  expect(partialPlural.calls.map((call) => call.text)).toEqual(["Some items"]);
  expect(Object.entries(formsOf(partialPlural.result, "de")!)).toEqual([
    ["countPlural=one", "Ein Ding"],
    ["countPlural=other", "Dinge"],
    ["countPlural=*", "[de] Some items"],
  ]);
  // a translated `other` goes before the target's catch-all
  const catchAll = await translate(
    formsBundle(countPlural, ["countPlural"], {
      en: pluralForms,
      de: { "countPlural=one": "Ein Ding", "countPlural=*": "Dinge" },
    }),
    ["de"],
  );
  expect(Object.entries(formsOf(catchAll.result, "de")!)).toEqual([
    ["countPlural=one", "Ein Ding"],
    ["countPlural=other", "[de] Items"],
    ["countPlural=*", "Dinge"],
  ]);
});

test("a plural whose type a select chooses needs the categories of each type", async () => {
  // i18next keys with cardinal and ordinal forms, as @inlang/plugin-i18next imports them
  const bundle = formsBundle(
    [
      input("pluralType"),
      input("count"),
      plural("countPlural", "count", { type: "$pluralType" }),
    ],
    ["pluralType", "count", "countPlural"],
    {
      en: {
        "pluralType=cardinal,count=0,countPlural=*": "None",
        "pluralType=ordinal,count=*,countPlural=one": "1st",
        "pluralType=ordinal,count=*,countPlural=two": "2nd",
        "pluralType=ordinal,count=*,countPlural=few": "3rd",
        "pluralType=ordinal,count=*,countPlural=other": "nth",
        "pluralType=*,count=*,countPlural=one": "One item",
        "pluralType=*,count=*,countPlural=other": "Items",
      },
    },
  );
  const { calls, result } = await translate(bundle, [
    "de",
    "ru",
    "sl",
    "pt_BR",
    "x-foo",
  ]);

  // German needs one and other (cardinal) and other (ordinal), Russian also
  // few and many, Brazilian Portuguese (written as some projects do) one and
  // other. Slovenian cardinal two and few aren't English ordinal two and few.
  expect(result.skippedPlurals).toEqual([
    { locale: "ru", categories: ["few", "many"] },
    { locale: "sl", categories: ["two", "few"] },
  ]);
  expect(calls.map((call) => call.targetLocale)).toEqual([
    ...Array(7).fill("de"),
    ...Array(7).fill("pt_BR"),
    ...Array(7).fill("x-foo"),
  ]);
  // the rules are known per type, unless the locale is unknown
  expect(result.unknownPluralRules).toEqual(["x-foo"]);
});

test("unknown plural rules skip nothing and are reported", async () => {
  // a locale `Intl` doesn't know
  const unknownLocale = await translate(
    formsBundle(countPlural, ["countPlural"], { en: items }),
    ["x-foo", "de"],
  );
  expect(unknownLocale.result.skippedPlurals).toEqual([]);
  expect(unknownLocale.result.unknownPluralRules).toEqual(["x-foo"]);
  expect(formsOf(unknownLocale.result, "x-foo")).toEqual({
    "countPlural=one": "[x-foo] One item",
    "countPlural=*": "[x-foo] Many items",
  });

  // a type a select chooses, next to an option only known at runtime
  const runtimeOption = await translate(
    formsBundle(
      [
        input("pluralType"),
        input("count"),
        input("digits"),
        plural("countPlural", "count", {
          type: "$pluralType",
          minimumFractionDigits: "$digits",
        }),
      ],
      ["pluralType", "countPlural"],
      {
        en: {
          "pluralType=ordinal,countPlural=one": "1st",
          "pluralType=ordinal,countPlural=*": "nth",
          "pluralType=*,countPlural=one": "One item",
          "pluralType=*,countPlural=*": "Items",
        },
      },
    ),
    ["ru"],
  );
  expect(runtimeOption.result.skippedPlurals).toEqual([]);
  expect(runtimeOption.result.unknownPluralRules).toEqual(["ru"]);
  expect(runtimeOption.calls).toHaveLength(4);

  // nothing copied, nothing to report
  const translated = await translate(
    formsBundle(countPlural, ["countPlural"], {
      en: items,
      "x-foo": { "countPlural=one": "Foo", "countPlural=*": "Foos" },
    }),
    ["x-foo"],
  );
  expect(translated.calls).toEqual([]);
  expect(translated.result.unknownPluralRules).toEqual([]);
});

test("forms the source lacks in its own locale too don't skip a locale", async () => {
  // English needs `one` as well: German is as complete as the source
  const bundle = formsBundle(countPlural, ["countPlural"], {
    en: { "countPlural=*": "{count} items" },
  });
  const { calls, result } = await translate(bundle, ["de", "ru"]);

  expect(result.skippedPlurals).toEqual([
    { locale: "ru", categories: ["few", "many"] },
  ]);
  expect(calls).toEqual([
    { text: "{count} items", targetLocale: "de", context: undefined },
  ]);
});

/** A pattern from text whose `{name}` are variables and `<b>`, `</b>` markup. */
function patternOf(text: string): Pattern {
  return text
    .split(/(\{\w+\}|<\/?\w+>)/)
    .filter(Boolean)
    .map((part) =>
      part.startsWith("{")
        ? {
            type: "expression",
            arg: { type: "variable-reference", name: part.slice(1, -1) },
          }
        : part.startsWith("</")
          ? { type: "markup-end", name: part.slice(2, -1) }
          : part.startsWith("<")
            ? { type: "markup-start", name: part.slice(1, -1) }
            : { type: "text", value: part },
    );
}

/** The text `patternOf` reads a pattern from. */
function textOf(pattern: Pattern): string {
  return pattern
    .map((part) =>
      part.type === "text"
        ? part.value
        : part.type === "expression"
          ? `{${(part.arg as { name: string }).name}}`
          : part.type === "markup-end"
            ? `</${part.name}>`
            : `<${part.name}>`,
    )
    .join("");
}

/** Reads the `{name}` in the bundle's texts as variables, `<b>` as markup. */
function withPlaceholders(bundle: BundleNested): BundleNested {
  for (const message of bundle.messages) {
    for (const variant of message.variants) {
      variant.pattern = patternOf(textOf(variant.pattern));
    }
  }
  return bundle;
}

/** Translates from English to `[locale] text`, then applies `edit`. */
function translateEditing(
  bundle: BundleNested,
  targetLocales: string[],
  edit: (text: string, targetLocale: string) => string,
  supportsContext = false,
) {
  return machineTranslateBundle({
    bundle,
    sourceLocale: "en",
    targetLocales,
    provider: {
      supportsContext,
      translateText: async ({ text, targetLocale }) => ({
        ok: true,
        translatedText: edit(`[${targetLocale}] ${text}`, targetLocale),
      }),
    },
  });
}

/** Removes the placeholders the provider gets as `notranslate` spans. */
const dropPlaceholders = (text: string) =>
  text.replace(/<span class="notranslate">.*?<\/span>/g, "");

const nameAndCount = [input("name"), ...countPlural];

test("a translation that drops a placeholder is reverted: an added variant is removed, a filled one is empty again", async () => {
  const bundle = withPlaceholders(
    formsBundle(nameAndCount, ["countPlural"], {
      en: {
        "countPlural=one": "{name} has one item",
        "countPlural=*": "{name} has {count} items",
      },
      de: { "countPlural=*": "" },
    }),
  );
  const result = await translateEditing(bundle, ["de"], dropPlaceholders);

  expect(result.reverted).toEqual([
    { locale: "de", placeholders: ["{name}"] },
    { locale: "de", placeholders: ["{name}", "{count}"] },
  ]);
});

test("a translation that changes markup is reverted", async () => {
  const bundle = withPlaceholders(
    formsBundle([], [], { en: { "": "Read the <link>terms</link>" } }),
  );
  const result = await translateEditing(bundle, ["de"], (text) =>
    text.replaceAll('"name":"link"', '"name":"a"'),
  );

  expect(result.reverted).toEqual([{ locale: "de", placeholders: ["<link>"] }]);
  expect(formsOf(result, "de")).toBeUndefined();
});

test("a translation that adds a variable is reverted", async () => {
  const bundle = withPlaceholders(
    formsBundle([input("name")], [], { en: { "": "Hello {name}" } }),
  );
  const result = await translateEditing(
    bundle,
    ["de"],
    (text) =>
      `${text}<span class="notranslate">{"type":"expression","arg":{"type":"variable-reference","name":"user"}}</span>`,
  );

  expect(result.reverted).toEqual([{ locale: "de", placeholders: ["{user}"] }]);
  expect(formsOf(result, "de")).toBeUndefined();
});

const itemCount = {
  "countPlural=one": "{count} item",
  "countPlural=*": "{count} items",
};

test("a new message with a reverted translation isn't created: French `one` (0 and 1) drops `{count}`", async () => {
  const bundle = withPlaceholders(
    formsBundle(countPlural, ["countPlural"], { en: itemCount }),
  );
  const result = await translateEditing(bundle, ["fr"], (text) =>
    text.endsWith(" item") ? dropPlaceholders(text) : text,
  );

  expect(result.reverted).toEqual([
    { locale: "fr", placeholders: ["{count}"] },
    { locale: "fr", placeholders: [] },
  ]);
  expect(formsOf(result, "fr")).toBeUndefined();
});

test("a translation that drops a placeholder doesn't revert the other translations of a message that exists", async () => {
  const bundle = withPlaceholders(
    formsBundle(countPlural, ["countPlural"], {
      en: itemCount,
      de: { "countPlural=*": "" },
    }),
  );
  const result = await translateEditing(bundle, ["de"], (text) =>
    text.endsWith(" items") ? dropPlaceholders(text) : text,
  );

  expect(result.reverted).toEqual([
    { locale: "de", placeholders: ["{count}"] },
  ]);
  expect(formsOf(result, "de")).toEqual({
    "countPlural=one": "[de] {count} item",
    "countPlural=*": "",
  });
});

test("a placeholder dropped from a form whose source lacks another one is reverted", async () => {
  const bundle = withPlaceholders(
    formsBundle(nameAndCount, ["countPlural"], {
      en: {
        "countPlural=one": "{name} has one item",
        "countPlural=*": "{name} has {count} items",
      },
      fr: { "countPlural=*": "{name} a {count} articles" },
    }),
  );
  // French `one` (0 and 1) lacks `{count}` with the source's text too
  const result = await translateEditing(bundle, ["fr"], dropPlaceholders);

  expect(result.reverted).toEqual([{ locale: "fr", placeholders: ["{name}"] }]);
  expect(formsOf(result, "fr")).toEqual({
    "countPlural=*": "{name} a {count} articles",
  });
});

test("a form only the target reaches is compared with its source form: English `zero` into Latvian", async () => {
  // English never selects `zero`, so the SDK would compare Latvian `zero`
  // (0, 10-20, ...) with English `*`, which has `<b>` and `{count}` but not
  // `{name}`; the translation is compared with English `zero`
  const bundle = withPlaceholders(
    formsBundle(nameAndCount, ["countPlural"], {
      en: {
        "countPlural=zero": "No items for {name}",
        "countPlural=one": "<b>{count}</b> item",
        "countPlural=*": "<b>{count}</b> items",
      },
    }),
  );
  const result = await translateEditing(bundle, ["lv"], (text) => text);

  expect(result.reverted).toEqual([]);
  expect(formsOf(result, "lv")).toEqual({
    "countPlural=zero": "[lv] No items for {name}",
    "countPlural=one": "[lv] <b>{count}</b> item",
    "countPlural=*": "[lv] <b>{count}</b> items",
  });

  const dropped = await translateEditing(bundle, ["lv"], (text) =>
    text.includes("No items") ? dropPlaceholders(text) : text,
  );
  expect(dropped.reverted).toEqual([
    { locale: "lv", placeholders: ["{name}"] },
    { locale: "lv", placeholders: [] },
    { locale: "lv", placeholders: [] },
  ]);
});

test("a variable missing from a hand-written translation blocks nothing and isn't reported", async () => {
  const bundle = withPlaceholders(
    formsBundle(nameAndCount, ["countPlural"], {
      en: {
        "countPlural=one": "{name} has one item",
        "countPlural=*": "{name} has {count} items",
      },
      de: { "countPlural=*": "Dinge" },
    }),
  );
  const result = await translateEditing(bundle, ["de"], (text) => text);

  expect(result.reverted).toEqual([]);
  expect(formsOf(result, "de")).toEqual({
    "countPlural=one": "[de] {name} has one item",
    "countPlural=*": "Dinge",
  });
});

test("a message whose added translations are all reverted keeps its order and ids", async () => {
  const bundle = withPlaceholders(
    formsBundle([input("gender"), input("name")], ["gender"], {
      en: {
        "gender=female": "{name} is here",
        "gender=male": "{name} is here",
        "gender=*": "{name} is here",
      },
      // not in the order of the source
      de: { "gender=*": "{name} ist da", "gender=female": "{name} ist da" },
    }),
  );
  const de = structuredClone(bundle.messages[1]!);
  const result = await translateEditing(bundle, ["de"], dropPlaceholders);

  expect(result.reverted).toEqual([{ locale: "de", placeholders: ["{name}"] }]);
  expect(result.data!.messages[1]).toEqual(de);
  expect(result.replacedVariantIds).toBeUndefined();
});

/** Translates with a provider that uses context: plurals are expanded. */
const expand = (bundle: BundleNested, targetLocales: string[]) =>
  translate(bundle, targetLocales, true);

const oneInRu =
  "Plural form: one (cardinal) in ru, used for n = 1, 21, 31…. Translate as the one form; the source shows the other form.";
const fewInRu =
  "Plural form: few (cardinal) in ru, used for n = 2–4, 22…. Translate as the few form; the source shows the other form.";
const manyInRu =
  "Plural form: many (cardinal) in ru, used for n = 0, 5–20…. Translate as the many form; the source shows the other form.";

test("with context, a target gets every plural form its language needs, each from its source form", async () => {
  const bundle = withPlaceholders(
    formsBundle(countPlural, ["countPlural"], { en: itemCount }),
  );
  bundle.description = "A cart";
  const { calls, result } = await expand(bundle, ["ru", "de"]);

  expect(result.skippedPlurals).toEqual([]);
  // in CLDR order, the catch-all last
  expect(Object.entries(formsOf(result, "ru")!)).toEqual([
    ["countPlural=one", "[ru] {count} items"],
    ["countPlural=few", "[ru] {count} items"],
    ["countPlural=many", "[ru] {count} items"],
    ["countPlural=*", "[ru] {count} items"],
  ]);
  // one, few and many say which form they are, after the description:
  // English `one` is 1, Russian `one` 1, 21, 31…, so it comes from `*`
  expect(
    calls.map(({ targetLocale, context }) => [targetLocale, context]),
  ).toEqual([
    ["ru", `A cart\n\n${oneInRu}`],
    ["ru", `A cart\n\n${fewInRu}`],
    ["ru", `A cart\n\n${manyInRu}`],
    ["ru", "A cart"],
    ["de", "A cart"],
    ["de", "A cart"],
  ]);
  expect(formsOf(result, "de")).toEqual({
    "countPlural=one": "[de] {count} item",
    "countPlural=*": "[de] {count} items",
  });
});

test("two plurals: the context names each category that isn't the source's", async () => {
  const bundle = formsBundle(
    [...countPlural, input("guests"), plural("guestsPlural", "guests")],
    ["countPlural", "guestsPlural"],
    {
      en: {
        "countPlural=one,guestsPlural=one": "One item for one guest",
        "countPlural=*,guestsPlural=*": "Items for guests",
      },
    },
  );
  const { calls, result } = await expand(bundle, ["ru"]);

  expect(Object.keys(formsOf(result, "ru")!)).toHaveLength(16);
  expect(formsOf(result, "ru")!["countPlural=few,guestsPlural=many"]).toBe(
    "[ru] Items for guests",
  );
  expect(calls[6]!.context).toBe(`${fewInRu}\n${manyInRu}`);
});

test("a form added to a message goes to its category's place, a variant only the target has stays where it is", async () => {
  // Arabic `zero` goes before the existing `one`
  const ar = await expand(
    formsBundle(countPlural, ["countPlural"], {
      en: items,
      ar: { "countPlural=one": "عنصر واحد", "countPlural=*": "عناصر" },
    }),
    ["ar"],
  );
  expect(Object.entries(formsOf(ar.result, "ar")!)).toEqual([
    ["countPlural=zero", "[ar] Many items"],
    ["countPlural=one", "عنصر واحد"],
    ["countPlural=two", "[ar] Many items"],
    ["countPlural=few", "[ar] Many items"],
    ["countPlural=many", "[ar] Many items"],
    ["countPlural=*", "عناصر"],
  ]);
  expect(ar.result.replacedVariantIds).toEqual([
    "01900000-0000-7000-8000-0000ar000000",
    "01900000-0000-7000-8000-0000ar000001",
  ]);

  // a hand-written exact 5 stays after `one`; few and many go before `*`
  const ru = await expand(
    formsBundle(countPlural, ["countPlural"], {
      en: items,
      ru: {
        "countPlural=one": "Один товар",
        "countPlural=5": "Пять товаров",
        "countPlural=*": "Товары",
      },
    }),
    ["ru"],
  );
  expect(Object.entries(formsOf(ru.result, "ru")!)).toEqual([
    ["countPlural=one", "Один товар"],
    ["countPlural=5", "Пять товаров"],
    ["countPlural=few", "[ru] Many items"],
    ["countPlural=many", "[ru] Many items"],
    ["countPlural=*", "Товары"],
  ]);
});

test("a new message is written in the target's order, whatever the source's", async () => {
  const { result } = await expand(
    formsBundle(countPlural, ["countPlural"], {
      en: { "countPlural=*": "Many items", "countPlural=one": "One item" },
    }),
    ["ru"],
  );

  expect(Object.keys(formsOf(result, "ru")!)).toEqual([
    "countPlural=one",
    "countPlural=few",
    "countPlural=many",
    "countPlural=*",
  ]);
  expect(result.replacedVariantIds).toBeUndefined();
});

test("`other` and the catch-all are the same form when expanding", async () => {
  // a source that writes `other` gets `other`, not a second catch-all
  const ru = await expand(
    formsBundle(countPlural, ["countPlural"], {
      en: { "countPlural=one": "One item", "countPlural=other": "Items" },
    }),
    ["ru"],
  );
  expect(Object.entries(formsOf(ru.result, "ru")!)).toEqual([
    ["countPlural=one", "[ru] Items"],
    ["countPlural=few", "[ru] Items"],
    ["countPlural=many", "[ru] Items"],
    ["countPlural=other", "[ru] Items"],
  ]);
  // the source's `other` is the target's
  expect(ru.calls.map((call) => call.context)).toEqual([
    oneInRu,
    fewInRu,
    manyInRu,
    undefined,
  ]);

  // an empty `other` is filled from the source's catch-all
  const de = await expand(
    formsBundle(countPlural, ["countPlural"], {
      en: items,
      de: { "countPlural=one": "Ein Ding", "countPlural=other": "" },
    }),
    ["de"],
  );
  expect(Object.entries(formsOf(de.result, "de")!)).toEqual([
    ["countPlural=one", "Ein Ding"],
    ["countPlural=other", "[de] Many items"],
  ]);
});

test("a plural whose type a select chooses gets the forms of each type", async () => {
  // i18next keys with cardinal and ordinal forms, as @inlang/plugin-i18next imports them
  const bundle = formsBundle(
    [
      input("pluralType"),
      input("count"),
      plural("countPlural", "count", { type: "$pluralType" }),
    ],
    ["pluralType", "count", "countPlural"],
    {
      en: {
        "pluralType=cardinal,count=0,countPlural=*": "None",
        "pluralType=ordinal,count=*,countPlural=one": "1st",
        "pluralType=ordinal,count=*,countPlural=two": "2nd",
        "pluralType=ordinal,count=*,countPlural=few": "3rd",
        "pluralType=ordinal,count=*,countPlural=other": "nth",
        "pluralType=*,count=*,countPlural=one": "One item",
        "pluralType=*,count=*,countPlural=other": "Items",
      },
    },
  );
  const { calls, result } = await expand(bundle, ["ru", "cy"]);

  // Russian has one ordinal form
  expect(Object.entries(formsOf(result, "ru")!)).toEqual([
    ["pluralType=cardinal,count=0,countPlural=*", "[ru] None"],
    ["pluralType=ordinal,count=*,countPlural=other", "[ru] nth"],
    ["pluralType=*,count=*,countPlural=one", "[ru] One item"],
    ["pluralType=*,count=*,countPlural=few", "[ru] Items"],
    ["pluralType=*,count=*,countPlural=many", "[ru] Items"],
    ["pluralType=*,count=*,countPlural=other", "[ru] Items"],
  ]);
  // Welsh `zero` is an ordinal and a cardinal form, each of its type
  expect(
    calls.flatMap((call) =>
      call.targetLocale === "cy" && call.context?.includes("zero")
        ? [call.context]
        : [],
    ),
  ).toEqual([
    "Plural form: zero (ordinal) in cy, used for n = 0, 7–9. Translate as the zero form; the source shows the other form.",
    "Plural form: zero (cardinal) in cy, used for n = 0. Translate as the zero form; the source shows the other form.",
  ]);
  expect(Object.keys(formsOf(result, "cy")!)).toHaveLength(13);
});

test("the examples follow the plural's offset and the locale as written in some projects", async () => {
  const offset = await expand(
    formsBundle(
      [input("count"), plural("countPlural", "count", { offset: "1" })],
      ["countPlural"],
      { en: items },
    ),
    ["ru"],
  );
  expect(offset.calls[1]!.context).toBe(
    "Plural form: few (cardinal) in ru, used for n = 3–5, 23…. Translate as the few form; the source shows the other form.",
  );

  const underscore = await expand(
    formsBundle(countPlural, ["countPlural"], { en: items }),
    ["ru_RU"],
  );
  expect(underscore.calls[1]!.context).toBe(
    "Plural form: few (cardinal) in ru_RU, used for n = 2–4, 22…. Translate as the few form; the source shows the other form.",
  );
});

test("unknown plural rules: the source's forms are copied and reported, with context too", async () => {
  const { result } = await expand(
    formsBundle(countPlural, ["countPlural"], { en: items }),
    ["x-foo", "ru"],
  );

  expect(result.unknownPluralRules).toEqual(["x-foo"]);
  expect(formsOf(result, "x-foo")).toEqual({
    "countPlural=one": "[x-foo] One item",
    "countPlural=*": "[x-foo] Many items",
  });
  expect(Object.keys(formsOf(result, "ru")!)).toHaveLength(4);
});

test("a batch provider gets every form of a locale in one request, the same source text several times", async () => {
  const calls: TranslateBatchArgs[] = [];
  const result = await machineTranslateBundle({
    bundle: formsBundle(countPlural, ["countPlural"], { en: items }),
    sourceLocale: "en",
    targetLocales: ["ru"],
    provider: {
      supportsContext: true,
      translateBatch: async (args) => {
        calls.push(args);
        return {
          ok: true,
          translatedTexts: {
            "0": "Один товар",
            "1": "Несколько товаров",
            "2": "Много товаров",
            "3": "Товары",
          },
        };
      },
    },
  });

  expect(calls).toEqual([
    {
      sourceLocale: "en",
      targetLocale: "ru",
      texts: {
        "0": { text: "Many items", context: oneInRu },
        "1": { text: "Many items", context: fewInRu },
        "2": { text: "Many items", context: manyInRu },
        "3": { text: "Many items" },
      },
    },
  ]);
  expect(Object.entries(formsOf(result, "ru")!)).toEqual([
    ["countPlural=one", "Один товар"],
    ["countPlural=few", "Несколько товаров"],
    ["countPlural=many", "Много товаров"],
    ["countPlural=*", "Товары"],
  ]);
});

test("the placeholder check compares a form with its source variant in another branch", async () => {
  // the male branch has only `one`: Russian `few · male` comes from English
  // `* · *`, which has `{count}`, while English `one · male` lacks it
  const bundle = withPlaceholders(
    formsBundle([input("gender"), ...countPlural], ["countPlural", "gender"], {
      en: {
        "countPlural=one,gender=male": "He has one item",
        "countPlural=*,gender=*": "They have {count} items",
      },
      ru: {
        "countPlural=one,gender=male": "У него один товар",
        "countPlural=*,gender=*": "У них {count} товаров",
      },
    }),
  );
  const result = await translateEditing(bundle, ["ru"], dropPlaceholders, true);

  expect(result.reverted).toEqual(
    Array(6).fill({ locale: "ru", placeholders: ["{count}"] }),
  );
  expect(formsOf(result, "ru")).toEqual({
    "countPlural=one,gender=male": "У него один товар",
    "countPlural=*,gender=*": "У них {count} товаров",
  });
});

test("a source with both `other` and the catch-all: every empty variant of the target's catch-all form is filled", async () => {
  const en = {
    "countPlural=one": "One item",
    "countPlural=other": "Items",
    "countPlural=*": "Unused",
  };
  const both = await expand(
    formsBundle(countPlural, ["countPlural"], {
      en,
      de: {
        "countPlural=one": "",
        "countPlural=other": "",
        "countPlural=*": "",
      },
    }),
    ["de"],
  );
  expect(Object.entries(formsOf(both.result, "de")!)).toEqual([
    ["countPlural=one", "[de] One item"],
    ["countPlural=other", "[de] Items"],
    ["countPlural=*", "[de] Items"],
  ]);

  // an empty `other` next to a hand-written catch-all
  const star = await expand(
    formsBundle(countPlural, ["countPlural"], {
      en,
      de: {
        "countPlural=one": "Ein Ding",
        "countPlural=other": "",
        "countPlural=*": "Dinge",
      },
    }),
    ["de"],
  );
  expect(Object.entries(formsOf(star.result, "de")!)).toEqual([
    ["countPlural=one", "Ein Ding"],
    ["countPlural=other", "[de] Items"],
    ["countPlural=*", "Dinge"],
  ]);
});

test("a source variant its own locale never shows isn't translated: Russian `few` from English `*`, not `few`", async () => {
  const { calls, result } = await expand(
    formsBundle(countPlural, ["countPlural"], {
      en: {
        "countPlural=one": "One item",
        "countPlural=few": "Unused",
        "countPlural=*": "Many items",
      },
    }),
    ["ru"],
  );

  expect(formsOf(result, "ru")).toEqual({
    "countPlural=one": "[ru] Many items",
    "countPlural=few": "[ru] Many items",
    "countPlural=many": "[ru] Many items",
    "countPlural=*": "[ru] Many items",
  });
  expect(calls[1]).toEqual({
    text: "Many items",
    targetLocale: "ru",
    context: fewInRu,
  });
});

test("a select value only the target has gets no forms; its variant stays where it is", async () => {
  const bundle = formsBundle(
    [input("gender"), ...countPlural],
    ["countPlural", "gender"],
    {
      en: {
        "countPlural=one,gender=*": "One item",
        "countPlural=*,gender=*": "Items",
      },
      ru: {
        "countPlural=*,gender=neuter": "Оно",
        "countPlural=*,gender=*": "Товары",
      },
    },
  );
  const { calls, result } = await expand(bundle, ["ru"]);

  expect(calls.map((call) => call.text)).toEqual(["Items", "Items", "Items"]);
  expect(Object.entries(formsOf(result, "ru")!)).toEqual([
    ["countPlural=*,gender=neuter", "Оно"],
    ["countPlural=one,gender=*", "[ru] Items"],
    ["countPlural=few,gender=*", "[ru] Items"],
    ["countPlural=many,gender=*", "[ru] Items"],
    ["countPlural=*,gender=*", "Товары"],
  ]);
});

test("a message without a plural gets only the source's forms, with context too", async () => {
  const { calls, result } = await expand(
    formsBundle([input("a"), input("b")], ["a", "b"], {
      en: { "a=x,b=*": "X", "a=*,b=y": "Y", "a=*,b=*": "Other" },
    }),
    ["de"],
  );

  expect(calls.map((call) => call.text)).toEqual(["X", "Y", "Other"]);
  expect(formsOf(result, "de")).toEqual({
    "a=x,b=*": "[de] X",
    "a=*,b=y": "[de] Y",
    "a=*,b=*": "[de] Other",
  });
});

test("a target whose selectors aren't the source's isn't expanded: skipped and reported", async () => {
  // a source without a plural
  const withoutPlural = formsBundle(countPlural, ["countPlural"], {
    en: { "": "Items" },
    ru: { "countPlural=one": "Один товар", "countPlural=*": "Товары" },
  });
  withoutPlural.messages[0]!.selectors = [];
  // a target with a gender the source doesn't select
  const withGender = formsBundle(
    [input("gender"), ...countPlural],
    ["countPlural"],
    {
      en: items,
      ru: {
        "countPlural=one,gender=*": "Один товар",
        "countPlural=*,gender=*": "Товары",
      },
    },
  );
  withGender.messages[1]!.selectors.push({
    type: "variable-reference",
    name: "gender",
  });

  for (const bundle of [withoutPlural, withGender]) {
    const ru = formsOf({ data: bundle }, "ru");
    const { calls, result } = await expand(bundle, ["ru"]);
    expect(calls).toEqual([]);
    expect(result.skippedPlurals).toEqual([
      { locale: "ru", categories: ["few", "many"] },
    ]);
    expect(formsOf(result, "ru")).toEqual(ru);
  }
});
