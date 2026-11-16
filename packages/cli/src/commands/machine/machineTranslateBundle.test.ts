import { expect, test } from "vitest";
import type { BundleNested, Declaration } from "@inlang/sdk";
import { machineTranslateBundle } from "./machineTranslateBundle.test-util.js";

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

/** `local <name> = <arg>`, e.g. an alias or ICU's exact-number selector. */
const local = (name: string, arg: string): Declaration => ({
  type: "local-variable",
  name,
  value: { type: "expression", arg: { type: "variable-reference", name: arg } },
});

const countPlural = [input("count"), plural("countPlural", "count")];

/**
 * A bundle with a message per locale. Forms are keyed by their matches,
 * `"countPlural=one,gender=*"`.
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
        matches: key.split(",").map((pair) => {
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
function recordingProvider() {
  const calls: Array<{ text: string; targetLocale: string; context?: string }> =
    [];
  return {
    calls,
    provider: {
      supportsContext: true,
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
function formsOf(
  result: Awaited<ReturnType<typeof machineTranslateBundle>>,
  locale: string,
) {
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
        (variant.pattern![0] as { value: string } | undefined)?.value ?? "",
      ]),
    )
  );
}

async function translate(
  bundle: BundleNested,
  targetLocales: string[],
  sourceLocale = "en",
) {
  const { calls, provider } = recordingProvider();
  const result = await machineTranslateBundle({
    bundle,
    sourceLocale,
    targetLocales,
    provider,
  });
  return { calls, result };
}

const items = { "countPlural=one": "One item", "countPlural=*": "Many items" };

test("a locale whose plurals need forms the source doesn't have is skipped, others are translated", async () => {
  const bundle = formsBundle(countPlural, ["countPlural"], { en: items });
  bundle.description = "A cart";
  const { calls, result } = await translate(bundle, ["ru", "de"]);

  expect(result.skippedPlurals).toEqual([
    { locale: "ru", categories: ["few", "many"] },
  ]);
  // no request and no message for ru
  expect(calls).toEqual([
    { text: "One item", targetLocale: "de", context: "A cart" },
    { text: "Many items", targetLocale: "de", context: "A cart" },
  ]);
  expect(formsOf(result, "ru")).toBeUndefined();
  expect(formsOf(result, "de")).toEqual({
    "countPlural=one": "[de] One item",
    "countPlural=*": "[de] Many items",
  });
  expect(result.unknownPluralRules).toEqual([]);
  expect(result.categoryKeySelectors).toEqual([]);
});

test("Arabic needs zero, two, few and many: skipped", async () => {
  const bundle = formsBundle(countPlural, ["countPlural"], { en: items });
  const { calls, result } = await translate(bundle, ["ar"]);

  expect(result.skippedPlurals).toEqual([
    { locale: "ar", categories: ["zero", "two", "few", "many"] },
  ]);
  expect(calls).toEqual([]);
  expect(formsOf(result, "ar")).toBeUndefined();
});

test("Japanese needs fewer forms: translated, `one` copied", async () => {
  const bundle = formsBundle(countPlural, ["countPlural"], { en: items });
  const { calls, result } = await translate(bundle, ["ja"]);

  expect(result.skippedPlurals).toEqual([]);
  expect(calls.map((call) => call.targetLocale)).toEqual(["ja", "ja"]);
  expect(formsOf(result, "ja")).toEqual({
    "countPlural=one": "[ja] One item",
    "countPlural=*": "[ja] Many items",
  });
});

test("ordinals follow the plural's type: English to French is translated, to Welsh skipped", async () => {
  const bundle = formsBundle(
    [input("place"), plural("placePlural", "place", { type: "ordinal" })],
    ["placePlural"],
    {
      en: {
        "placePlural=one": "1st",
        "placePlural=two": "2nd",
        "placePlural=few": "3rd",
        "placePlural=*": "nth",
      },
    },
  );
  const { calls, result } = await translate(bundle, ["fr", "cy"]);

  // French ordinals are one and other; Welsh adds zero and many
  expect(result.skippedPlurals).toEqual([
    { locale: "cy", categories: ["zero", "many"] },
  ]);
  expect(calls.map((call) => call.text)).toEqual(["1st", "2nd", "3rd", "nth"]);
  expect(Object.keys(formsOf(result, "fr")!)).toEqual([
    "placePlural=one",
    "placePlural=two",
    "placePlural=few",
    "placePlural=*",
  ]);
});

test("a plural selected together with a gender is skipped when any combination lacks a category", async () => {
  const bundle = formsBundle(
    [input("gender"), ...countPlural],
    ["countPlural", "gender"],
    {
      en: {
        "countPlural=one,gender=female": "She has one item",
        "countPlural=one,gender=male": "He has one item",
        "countPlural=one,gender=*": "They have one item",
        "countPlural=*,gender=female": "She has items",
        "countPlural=*,gender=male": "He has items",
        "countPlural=*,gender=*": "They have items",
      },
    },
  );
  const { calls, result } = await translate(bundle, ["ru", "de"]);

  expect(result.skippedPlurals).toEqual([
    { locale: "ru", categories: ["few", "many"] },
  ]);
  expect(calls).toHaveLength(6);
  expect(calls.every((call) => call.targetLocale === "de")).toBe(true);
  expect(formsOf(result, "ru")).toBeUndefined();
});

test("two plurals: only the categories no source variant has are needed", async () => {
  const bundle = formsBundle(
    [...countPlural, input("guests"), plural("guestsPlural", "guests")],
    ["countPlural", "guestsPlural"],
    {
      en: {
        "countPlural=one,guestsPlural=one": "One item for one guest",
        "countPlural=one,guestsPlural=*": "One item for guests",
        "countPlural=*,guestsPlural=one": "Items for one guest",
        "countPlural=*,guestsPlural=*": "Items for guests",
      },
    },
  );
  const { result } = await translate(bundle, ["ru"]);

  // `one` is in combinations Russian lacks, e.g. `one` × `few`
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

test("`other` and the catch-all are the same form", async () => {
  // the source's `other` is the target's catch-all: no second one is added
  const other = await translate(
    formsBundle(countPlural, ["countPlural"], {
      en: { "countPlural=one": "One item", "countPlural=other": "Items" },
      de: { "countPlural=*": "Dinge" },
    }),
    ["de"],
  );
  expect(other.calls.map((call) => call.text)).toEqual(["One item"]);
  expect(formsOf(other.result, "de")).toEqual({
    "countPlural=one": "[de] One item",
    "countPlural=*": "Dinge",
  });

  // and the other way around; the translated `one` goes before `other`
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

  // coverage is the same: Russian still lacks few and many
  const ru = await translate(
    formsBundle(countPlural, ["countPlural"], {
      en: { "countPlural=one": "One item", "countPlural=other": "Items" },
    }),
    ["ru"],
  );
  expect(ru.result.skippedPlurals).toEqual([
    { locale: "ru", categories: ["few", "many"] },
  ]);
});

test("a source with both `other` and the catch-all keeps both", async () => {
  // a select's `other` is a value like any other
  const gender = [input("gender")];
  const genderForms = {
    "gender=female": "She",
    "gender=other": "They (other)",
    "gender=*": "They",
  };
  const newSelect = await translate(
    formsBundle(gender, ["gender"], { en: genderForms }),
    ["de"],
  );
  expect(formsOf(newSelect.result, "de")).toEqual({
    "gender=female": "[de] She",
    "gender=other": "[de] They (other)",
    "gender=*": "[de] They",
  });
  const partialSelect = await translate(
    formsBundle(gender, ["gender"], {
      en: genderForms,
      de: { "gender=female": "Sie", "gender=other": "Andere", "gender=*": "" },
    }),
    ["de"],
  );
  expect(partialSelect.calls.map((call) => call.text)).toEqual(["They"]);
  expect(formsOf(partialSelect.result, "de")).toEqual({
    "gender=female": "Sie",
    "gender=other": "Andere",
    "gender=*": "[de] They",
  });
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
  const newPlural = await translate(
    formsBundle(countPlural, ["countPlural"], { en: pluralForms }),
    ["ja"],
  );
  expect(formsOf(newPlural.result, "ja")).toEqual({
    "countPlural=one": "[ja] One item",
    "countPlural=other": "[ja] Items",
    "countPlural=*": "[ja] Some items",
  });
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
});

test("an ICU exact number next to a plural: the plural decides", async () => {
  // `{count, plural, =0 {…} one {…} other {…}}` as @inlang/plugin-icu1 imports it
  const bundle = formsBundle(
    [...countPlural, local("countPluralExact", "count")],
    ["countPluralExact", "countPlural"],
    {
      en: {
        "countPluralExact=0,countPlural=*": "No items",
        "countPluralExact=*,countPlural=one": "One item",
        "countPluralExact=*,countPlural=*": "Many items",
      },
    },
  );
  const { calls, result } = await translate(bundle, ["ru", "de"]);

  expect(result.skippedPlurals).toEqual([
    { locale: "ru", categories: ["few", "many"] },
  ]);
  expect(calls.map((call) => call.targetLocale)).toEqual(["de", "de", "de"]);
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
  // pluralType's keys aren't categories
  expect(result.categoryKeySelectors).toEqual([]);
});

test("unknown plural rules skip nothing and are reported", async () => {
  // a locale `Intl` doesn't know, and a type only known at runtime
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

  const runtimeType = await translate(
    formsBundle(
      [
        input("count"),
        input("mode"),
        plural("countPlural", "count", { type: "$mode" }),
      ],
      ["countPlural"],
      { en: items },
    ),
    ["ru"],
  );
  expect(runtimeType.result.skippedPlurals).toEqual([]);
  expect(runtimeType.result.unknownPluralRules).toEqual(["ru"]);
  expect(runtimeType.calls).toHaveLength(2);

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

test("a selector with plural categories as keys that isn't a plural is reported", async () => {
  // a bare `count`: `one` and `other` only match those words, never a number
  const { calls, result } = await translate(
    formsBundle([input("count")], ["count"], {
      en: { "count=one": "One item", "count=other": "Items", "count=*": "?" },
    }),
    ["ru"],
  );
  expect(result.categoryKeySelectors).toEqual(["count"]);
  // translated as a select
  expect(result.skippedPlurals).toEqual([]);
  expect(calls).toHaveLength(3);

  // keys that aren't all categories, or a plural
  const keys = await translate(
    formsBundle([input("count")], ["count"], {
      en: { "count=one": "One item", "count=3": "Three", "count=*": "?" },
    }),
    ["ru"],
  );
  expect(keys.result.categoryKeySelectors).toEqual([]);
  const catchAll = await translate(
    formsBundle([input("count")], ["count"], { en: { "count=*": "Items" } }),
    ["ru"],
  );
  expect(catchAll.result.categoryKeySelectors).toEqual([]);
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

// The locales and plural messages of paraglide-js #898's init tests
// (src/cli/commands/init/command.test.ts, "General Translation setup ...").
// #898 left a locale out of GT's setup when the source's plurals lacked its
// forms, and every locale when it couldn't check the plural; here the
// SDK's `missingVariants` decides for each locale.
test.each<{
  name: string;
  baseLocale: string;
  locales: string[];
  declarations: Declaration[];
  selectors: string[];
  forms: Record<string, string>;
  translated: string[];
  skipped: string[];
  /** locales translated without known plural rules */
  unknown?: string[];
}>([
  {
    name: "one and * into de, fr and ru",
    baseLocale: "en",
    locales: ["de", "fr", "ru"],
    declarations: [input("count"), plural("countPlural", "count")],
    selectors: ["countPlural"],
    forms: {
      "countPlural=one": "{count} item",
      "countPlural=*": "{count} items",
    },
    translated: ["de", "fr"],
    skipped: ["ru"],
  },
  {
    name: "cardinal plurals unsupported by every target",
    baseLocale: "en",
    locales: ["ru"],
    declarations: [input("place"), plural("placePlural", "place")],
    selectors: ["placePlural"],
    forms: {
      "placePlural=one": "{place} item",
      "placePlural=*": "{place} items",
    },
    translated: [],
    skipped: ["ru"],
  },
  {
    name: "ordinal plurals",
    baseLocale: "de",
    locales: ["en", "ja"],
    declarations: [
      input("place"),
      plural("placePlural", "place", { type: "ordinal" }),
    ],
    selectors: ["placePlural"],
    forms: { "placePlural=*": "{place}." },
    translated: ["ja"],
    skipped: ["en"],
  },
  {
    // #898: ["ja"]; French `many` is only for millions, `other` is the catch-all
    name: "cardinal plurals without a * branch",
    baseLocale: "en",
    locales: ["fr", "ja"],
    declarations: [input("place"), plural("placePlural", "place")],
    selectors: ["placePlural"],
    forms: {
      "placePlural=one": "{place} item",
      "placePlural=other": "{place} items",
    },
    translated: ["fr", "ja"],
    skipped: [],
  },
  {
    // #898: none; German and Icelandic have English's categories
    name: "plurals selected together with another variable",
    baseLocale: "en",
    locales: ["de", "is"],
    declarations: [
      input("place"),
      input("gender"),
      plural("placePlural", "place"),
    ],
    selectors: ["gender", "placePlural"],
    forms: {
      "gender=female,placePlural=one": "{place} item",
      "gender=*,placePlural=*": "{place} items",
    },
    translated: ["de", "is"],
    skipped: [],
  },
  {
    // #898: none
    name: "aliased plurals",
    baseLocale: "en",
    locales: ["ru", "ja"],
    declarations: [
      input("place"),
      plural("rawPlural", "place"),
      local("placePlural", "rawPlural"),
    ],
    selectors: ["placePlural"],
    forms: {
      "placePlural=one": "{place} item",
      "placePlural=*": "{place} items",
    },
    translated: ["ja"],
    skipped: ["ru"],
  },
  {
    // #898: none; the rules are unknown, so only the catch-all is needed
    name: "plurals whose type is a variable",
    baseLocale: "de",
    locales: ["en", "ja"],
    declarations: [
      input("place"),
      input("mode"),
      plural("placePlural", "place", { type: "$mode" }),
    ],
    selectors: ["placePlural"],
    forms: { "placePlural=one": "{place}st", "placePlural=*": "{place}th" },
    translated: ["en", "ja"],
    skipped: [],
    unknown: ["en", "ja"],
  },
])(
  "paraglide-js #898: $name",
  async ({
    baseLocale,
    locales,
    declarations,
    selectors,
    forms,
    translated,
    skipped,
    unknown = [],
  }) => {
    const { calls, result } = await translate(
      formsBundle(declarations, selectors, { [baseLocale]: forms }),
      locales,
      baseLocale,
    );
    expect(result.skippedPlurals!.map(({ locale }) => locale)).toEqual(skipped);
    expect([...new Set(calls.map((call) => call.targetLocale))]).toEqual(
      translated,
    );
    expect(result.unknownPluralRules).toEqual(unknown);
    for (const locale of skipped) {
      expect(formsOf(result, locale)).toBeUndefined();
    }
  },
);
