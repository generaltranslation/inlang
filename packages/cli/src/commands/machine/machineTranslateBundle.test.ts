import { expect, test } from "vitest";
import type {
  BundleNested,
  Declaration,
  NewBundleNested,
  Pattern,
} from "@inlang/sdk";
import { checkTranslation } from "@inlang/sdk";
import {
  planBundleTranslation,
  translateMissing,
} from "./machineTranslateBundle.js";
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
  return { calls, result: { ...plan, ...result } };
}

const items = { "countPlural=one": "One item", "countPlural=*": "Many items" };

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
  expect(result.incompletePlurals).toEqual([
    { locale: "ru", categories: ["few", "many"] },
  ]);
});

test("a target complete for one gender is reported when another lacks a category", async () => {
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

  // `female` is the source's; its forms are still translated
  expect(result.incompletePlurals).toEqual([
    { locale: "ru", categories: ["few", "many"] },
  ]);
  expect(calls.map((call) => call.text)).toEqual([
    "She has one item",
    "She has items",
  ]);
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
  const { result } = await translate(bundle, ["de"]);

  // German lacks `one` × `diverse`, as English does
  expect(result.incompletePlurals).toEqual([]);
});

test("empty forms are missing forms: a target whose plural forms are all empty is reported", async () => {
  const bundle = formsBundle(countPlural, ["countPlural"], {
    en: items,
    ru: {
      "countPlural=one": "",
      "countPlural=few": "",
      "countPlural=many": "",
      "countPlural=*": "",
    },
  });
  const { result } = await translate(bundle, ["ru"]);

  expect(result.incompletePlurals).toEqual([
    { locale: "ru", categories: ["few", "many"] },
  ]);
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

  expect(result.incompletePlurals).toEqual([
    { locale: "ru", categories: ["many"] },
  ]);
  // and that the source can't fill it, many and the catch-all alike
  expect(result.differentSelectors).toEqual(["ru"]);
  // the source's text wouldn't fit the plural: it is left as it is
  expect(calls).toEqual([]);
  // complete but for an empty form, it is reported too
  const ru = bundle.messages.find((message) => message.locale === "ru")!;
  ru.variants.push(
    {
      ...ru.variants[0]!,
      id: "many",
      matches: [{ type: "literal-match", key: "countPlural", value: "many" }],
    },
    {
      ...ru.variants[0]!,
      id: "other",
      matches: [{ type: "catchall-match", key: "countPlural" }],
    },
  );
  ru.variants[0]!.pattern = [];
  expect(
    planBundleTranslation({
      bundle,
      sourceLocale: "en",
      targetLocales: ["ru"],
    }),
  ).toMatchObject({ missing: [], differentSelectors: ["ru"] });
});

test("a complete translation with other selectors than the source's isn't reported", async () => {
  // a source without a plural, and a hand-written Russian plural with every form
  const bundle = formsBundle(countPlural, ["countPlural"], {
    en: { "countPlural=*": "Items" },
    ru: {
      "countPlural=one": "Один товар",
      "countPlural=few": "Несколько товаров",
      "countPlural=many": "Много товаров",
      "countPlural=*": "Товары",
    },
  });
  const en = bundle.messages.find((message) => message.locale === "en")!;
  en.selectors = [];
  en.variants[0]!.matches = [];
  const { calls, result } = await translate(bundle, ["ru"]);

  expect(result.incompletePlurals).toEqual([]);
  expect(result.differentSelectors).toEqual([]);
  expect(calls).toEqual([]);
});

test("a translation with other selectors than the source's is left as it is", async () => {
  // a Japanese text written by hand without the source's plural: the
  // source's forms would match on a selector it doesn't have
  const bundle = formsBundle(countPlural, ["countPlural"], {
    en: items,
    ja: { "countPlural=*": "" },
  });
  const ja = bundle.messages.find((message) => message.locale === "ja")!;
  ja.selectors = [];
  ja.variants[0]!.matches = [];
  ja.variants[0]!.pattern = [{ type: "text", value: "アイテム" }];
  const { calls, result } = await translate(bundle, ["ja", "de"]);

  // it lacks no translation, so it isn't reported
  expect(result.differentSelectors).toEqual([]);
  expect(result.incompletePlurals).toEqual([]);
  // German, without a message, gets the source's forms
  expect(calls.map((call) => call.text)).toEqual(["One item", "Many items"]);
  expect(
    result.data!.messages.find((message) => message.locale === "ja"),
  ).toMatchObject({ selectors: [], variants: [{ matches: [] }] });

  // an empty one is reported, as it lacks a translation
  ja.variants[0]!.pattern = [];
  expect(
    planBundleTranslation({
      bundle,
      sourceLocale: "en",
      targetLocales: ["ja"],
    }),
  ).toMatchObject({
    missing: [],
    differentSelectors: ["ja"],
  });
  // one without forms gets the source's, as a new message does
  ja.variants = [];
  const plan = planBundleTranslation({
    bundle,
    sourceLocale: "en",
    targetLocales: ["ja"],
  });
  if ("error" in plan) throw new Error(plan.error);
  expect(plan.missing.map(({ text }) => text)).toEqual([
    "One item",
    "Many items",
  ]);
  expect(plan.differentSelectors).toEqual([]);
});

test("selectors in another order are the source's", async () => {
  const bundle = formsBundle(
    [...countPlural, input("gender")],
    ["countPlural", "gender"],
    {
      en: {
        "countPlural=one,gender=*": "One item",
        "countPlural=*,gender=*": "Items",
      },
      de: {
        "countPlural=one,gender=*": "",
        "countPlural=*,gender=*": "Artikel",
      },
    },
  );
  const de = bundle.messages.find((message) => message.locale === "de")!;
  de.selectors.reverse();
  const { calls, result } = await translate(bundle, ["de"]);

  expect(calls.map((call) => call.text)).toEqual(["One item"]);
  expect(result.differentSelectors).toEqual([]);
});

test("a translation with other selectors that lacks a form is reported", async () => {
  // a German plural with a gender written by hand, without `one`, which the
  // source has
  const bundle = formsBundle(
    [...countPlural, input("gender")],
    ["countPlural", "gender"],
    {
      en: {
        "countPlural=one,gender=*": "One item",
        "countPlural=*,gender=*": "Items",
      },
      de: { "countPlural=*,gender=*": "Artikel" },
    },
  );
  const en = bundle.messages.find((message) => message.locale === "en")!;
  en.selectors = en.selectors.slice(0, 1);
  for (const variant of en.variants)
    variant.matches = variant.matches.slice(0, 1);
  const { calls, result } = await translate(bundle, ["de"]);

  expect(calls).toEqual([]);
  expect(result.incompletePlurals).toEqual([]);
  expect(result.differentSelectors).toEqual(["de"]);
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
  const { result } = await translate(bundle, [
    "de",
    "ru",
    "sl",
    "pt_BR",
    "x-foo",
  ]);

  // German needs one and other (cardinal) and other (ordinal), Russian also
  // few and many, Brazilian Portuguese (written as some projects do) one and
  // other. Slovenian cardinal two and few aren't English ordinal two and few.
  expect(result.incompletePlurals).toEqual([
    { locale: "ru", categories: ["few", "many"] },
    { locale: "sl", categories: ["two", "few"] },
  ]);
  // the rules are known per type, unless the locale is unknown
  expect(result.unknownPluralRules).toEqual(["x-foo"]);
});

test("a locale with nothing to translate isn't reported for unknown plural rules", async () => {
  const bundle = formsBundle(countPlural, ["countPlural"], {
    en: items,
    "x-foo": { "countPlural=one": "Foo", "countPlural=*": "Foos" },
  });
  const { result } = await translate(bundle, ["x-foo"]);

  expect(result.unknownPluralRules).toEqual([]);
});

test("forms the source lacks in its own locale too aren't reported", async () => {
  // English needs `one` as well: German is as complete as the source
  const bundle = formsBundle(countPlural, ["countPlural"], {
    en: { "countPlural=*": "{count} items" },
  });
  const { result } = await translate(bundle, ["de", "ru"]);

  expect(result.incompletePlurals).toEqual([
    { locale: "ru", categories: ["few", "many"] },
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
  edit: (text: string) => string,
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
        translatedText: edit(`[${targetLocale}] ${text}`),
      }),
    },
  });
}

/** A placeholder as the provider gets it: a `notranslate` span. */
const span = '<span class="notranslate">[^<]*</span>';

/** Removes the placeholders the provider gets. */
const dropPlaceholders = (text: string) =>
  text.replace(new RegExp(span, "g"), "");

const nameAndCount = [input("name"), ...countPlural];

test("a translation that drops a markup end is rejected", async () => {
  const result = await translateEditing(
    withPlaceholders(
      formsBundle([], [], { en: { "": "Read the <link>Terms</link>" } }),
    ),
    ["de"],
    (text) =>
      text.replace(
        '<span class="notranslate">{"type":"markup-end","name":"link"}</span>',
        "",
      ),
  );

  expect(result.rejected).toEqual([{ locale: "de", reasons: ["</link>"] }]);
});

test("a translation that changes an option of a placeholder is rejected", async () => {
  const bundle = formsBundle([input("price")], [], { en: { "": "Total: " } });
  bundle.messages[0]!.variants[0]!.pattern.push({
    type: "expression",
    arg: { type: "variable-reference", name: "price" },
    annotation: {
      type: "function-reference",
      name: "number",
      options: [
        { name: "style", value: { type: "literal", value: "currency" } },
        { name: "currency", value: { type: "literal", value: "USD" } },
      ],
    },
  });
  const result = await translateEditing(bundle, ["de"], (text) =>
    text.replace('"USD"', '"EUR"'),
  );

  expect(result.rejected).toEqual([{ locale: "de", reasons: ["{price}"] }]);
});

test("a translation may move placeholders and reorder their keys", async () => {
  const bundle = withPlaceholders(
    formsBundle(nameAndCount, [], { en: { "": "{name}: <b>{count}</b>" } }),
  );
  const result = await translateEditing(bundle, ["de"], (text) => {
    const [name, start, count, end] = text.match(new RegExp(span, "g"))!;
    return `${start}${count}${end} ${name!.replace(
      '{"type":"expression","arg":{"type":"variable-reference","name":"name"}}',
      '{"arg":{"name":"name","type":"variable-reference"},"type":"expression"}',
    )}`;
  });

  expect(result.rejected).toEqual([]);
});

test("a translation that repeats a placeholder is rejected", async () => {
  const bundle = withPlaceholders(
    formsBundle([input("name")], [], { en: { "": "Hello {name}" } }),
  );
  const result = await translateEditing(bundle, ["de"], (text) =>
    text.replace(new RegExp(span), "$& $&"),
  );

  expect(result.rejected).toEqual([{ locale: "de", reasons: ["{name}"] }]);
});

test("markup that doesn't nest is rejected, unless the source's doesn't either", async () => {
  const crossed = await translateEditing(
    withPlaceholders(
      formsBundle([], [], { en: { "": "<b>Bold <i>both</i></b>" } }),
    ),
    ["de"],
    // <b>Bold <i>both</b></i>
    (text) => text.replace(new RegExp(`(${span})(${span})$`), "$2$1"),
  );
  expect(crossed.rejected).toEqual([
    { locale: "de", reasons: ["</b>", "<b>"] },
  ]);

  const unclosed = await translateEditing(
    withPlaceholders(formsBundle([], [], { en: { "": "<b>Bold" } })),
    ["de"],
    (text) => text.replace(new RegExp(`(${span})(.*)`), "$2 $1"),
  );
  expect(unclosed.rejected).toEqual([]);
});

test("an empty translation of a text is rejected", async () => {
  const result = await translateEditing(
    formsBundle([], [], { en: { "": "Hello" } }),
    ["fr"],
    () => " ",
  );
  expect(result.rejected).toEqual([{ locale: "fr", reasons: ["empty"] }]);

  const blank = await translateEditing(
    formsBundle([], [], { en: { "": " " } }),
    ["de"],
    () => "",
  );
  expect(blank.rejected).toEqual([]);
});

const itemCount = {
  "countPlural=one": "{count} item",
  "countPlural=*": "{count} items",
};

test("expanded Arabic forms may spell out their count, as the SDK check allows", () => {
  const bundle = withPlaceholders(
    formsBundle(countPlural, ["countPlural"], { en: itemCount }),
  );
  const plan = planBundleTranslation({
    bundle,
    sourceLocale: "en",
    targetLocales: ["ar"],
    supportsContext: true,
  });
  if ("error" in plan) throw Error(plan.error);
  const spelled: Record<string, string> = {
    zero: "لا ملفات",
    one: "ملف",
    two: "ملفان",
  };
  const result = plan.apply(
    new Map(
      plan.missing.map((translation) => {
        const category = translation.matches.find(
          (match) => match.type === "literal-match",
        );
        const text =
          category?.type === "literal-match"
            ? spelled[category.value]
            : undefined;
        return [
          translation,
          text
            ? [{ type: "text", value: text }]
            : translation.sourceVariant.pattern,
        ];
      }),
    ),
  );
  expect(result.rejected).toEqual([]);
  const target = result.data.messages.find(
    (message) => message.locale === "ar",
  )!;
  expect(target.variants).toHaveLength(6);
  expect(
    checkTranslation({
      reference: bundle.messages[0],
      target: {
        ...target,
        selectors: target.selectors ?? [],
        variants: target.variants.map((variant) => ({
          ...variant,
          matches: variant.matches ?? [],
          pattern: variant.pattern ?? [],
        })),
      },
      declarations: bundle.declarations,
    }),
  ).toEqual([]);
});

test("a German singular and an exact number may omit their own count", async () => {
  const singular = await translateEditing(
    withPlaceholders(
      formsBundle(countPlural, ["countPlural"], { en: itemCount }),
    ),
    ["de"],
    (text) => (text.endsWith(" item") ? dropPlaceholders(text) : text),
  );
  expect(singular.rejected).toEqual([]);
  const exact = await translateEditing(
    withPlaceholders(
      formsBundle([input("count")], ["count"], {
        en: { "count=4": "{count} items", "count=*": "{count} things" },
      }),
    ),
    ["ru"],
    (text) => (text.endsWith(" items") ? dropPlaceholders(text) : text),
  );
  expect(exact.rejected).toEqual([]);
});

test("a single-number form still requires other variables and rejects added counts", async () => {
  const bundle = withPlaceholders(
    formsBundle(nameAndCount, ["countPlural"], {
      en: {
        "countPlural=one": "{name}: {count} item",
        "countPlural=*": "{name}: {count} items",
      },
    }),
  );
  const missingName = await translateEditing(bundle, ["de"], (text) =>
    text.endsWith(" item") ? dropPlaceholders(text) : text,
  );
  expect(missingName.rejected).toContainEqual({
    locale: "de",
    reasons: ["{name}"],
  });
  const repeated = await translateEditing(
    withPlaceholders(
      formsBundle(countPlural, ["countPlural"], { en: itemCount }),
    ),
    ["de"],
    (text) =>
      text.endsWith(" item") ? text.replace(new RegExp(span), "$&$&") : text,
  );
  expect(repeated.rejected).toContainEqual({
    locale: "de",
    reasons: ["{count}"],
  });
});

test("a single-number form cannot change or omit a formatted count", async () => {
  const bundle = withPlaceholders(
    formsBundle(countPlural, ["countPlural"], { en: itemCount }),
  );
  const count = bundle.messages[0]!.variants[0]!.pattern.find(
    (part) => part.type === "expression",
  )!;
  if (count.type !== "expression") throw Error("Expected count");
  count.annotation = {
    type: "function-reference",
    name: "number",
    options: [
      { name: "style", value: { type: "literal", value: "currency" } },
      { name: "currency", value: { type: "literal", value: "USD" } },
    ],
  };
  for (const edit of [
    (text: string) => text.replace('"USD"', '"EUR"'),
    (text: string) => (text.endsWith(" item") ? dropPlaceholders(text) : text),
  ]) {
    const result = await translateEditing(bundle, ["de"], edit);
    expect(result.rejected).toContainEqual({
      locale: "de",
      reasons: ["{count}"],
    });
  }
});

test("a single-number form may spell out ICU's #", async () => {
  const bundle = withPlaceholders(
    formsBundle(countPlural, ["countPlural"], { en: itemCount }),
  );
  for (const variant of bundle.messages[0]!.variants) {
    for (const part of variant.pattern)
      if (part.type === "expression") {
        part.annotation = {
          type: "function-reference",
          name: "icu:pound",
          options: [],
        };
      }
  }
  const result = await translateEditing(bundle, ["de"], (text) =>
    text.endsWith(" item") ? dropPlaceholders(text) : text,
  );
  expect(result.rejected).toEqual([]);
});

test("a new message with a rejected translation isn't created: French `one` (0 and 1) drops `{count}`", async () => {
  const bundle = withPlaceholders(
    formsBundle(countPlural, ["countPlural"], { en: itemCount }),
  );
  const result = await translateEditing(bundle, ["fr"], (text) =>
    text.endsWith(" item") ? dropPlaceholders(text) : text,
  );

  expect(result.rejected).toEqual([
    { locale: "fr", reasons: ["{count}"] },
    { locale: "fr", reasons: [] },
  ]);
});

test("a translation that drops a placeholder doesn't reject the other translations of a message that exists", async () => {
  const bundle = withPlaceholders(
    formsBundle(countPlural, ["countPlural"], {
      en: itemCount,
      de: { "countPlural=*": "" },
    }),
  );
  const result = await translateEditing(bundle, ["de"], (text) =>
    text.endsWith(" items") ? dropPlaceholders(text) : text,
  );

  expect(result.rejected).toEqual([{ locale: "de", reasons: ["{count}"] }]);
});

test("a placeholder dropped from a form whose source lacks another one is rejected", async () => {
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

  expect(result.rejected).toEqual([{ locale: "fr", reasons: ["{name}"] }]);
});

/** Translates with a provider that uses context: plurals are expanded. */
const expand = (bundle: BundleNested, targetLocales: string[]) =>
  translate(bundle, targetLocales, true);

const oneInRu =
  "Plural form for {count}: one (cardinal) in ru, used for n = 1, 21, 31…. Translate as the one form; the source shows the other form.";
const fewInRu =
  "Plural form for {count}: few (cardinal) in ru, used for n = 2–4, 22…. Translate as the few form; the source shows the other form.";
const manyInRu =
  "Plural form for {count}: many (cardinal) in ru, used for n = 0, 5–20…. Translate as the many form; the source shows the other form.";

const otherInRu =
  "Plural form for {count}: other (cardinal) in ru, used for n = 1.5. Translate as the other form; the source shows the other form.";

test("with context, a target gets every plural form its language needs, each from its source form", async () => {
  const bundle = withPlaceholders(
    formsBundle(countPlural, ["countPlural"], { en: itemCount }),
  );
  bundle.description = "A cart";
  const { calls, result } = await expand(bundle, ["ru", "de"]);

  expect(result.incompletePlurals).toEqual([]);
  // in CLDR order, the catch-all last
  expect(Object.entries(formsOf(result, "ru")!)).toEqual([
    ["countPlural=one", "[ru] {count} items"],
    ["countPlural=few", "[ru] {count} items"],
    ["countPlural=many", "[ru] {count} items"],
    ["countPlural=*", "[ru] {count} items"],
  ]);
  // Every form identifies its input and category after the description:
  // English `one` is 1, Russian `one` 1, 21, 31…, so it comes from `*`
  expect(
    calls.map(({ targetLocale, context }) => [targetLocale, context]),
  ).toEqual([
    ["ru", `A cart\n\n${oneInRu}`],
    ["ru", `A cart\n\n${fewInRu}`],
    ["ru", `A cart\n\n${manyInRu}`],
    ["ru", `A cart\n\n${otherInRu}`],
    [
      "de",
      "A cart\n\nPlural form for {count}: one (cardinal) in de, used for n = 1. Translate as the one form; the source shows the one form.",
    ],
    [
      "de",
      "A cart\n\nPlural form for {count}: other (cardinal) in de, used for n = 0, 2, 3…. Translate as the other form; the source shows the other form.",
    ],
  ]);
  expect(formsOf(result, "de")).toEqual({
    "countPlural=one": "[de] {count} item",
    "countPlural=*": "[de] {count} items",
  });
});

test("Arabic `zero`, which selects only 0, is the exact 0 form, as the i18next plugin reads Arabic `_zero` back", async () => {
  const nothingMissing = (
    declarations: Declaration[],
    selectors: string[],
    messages: Record<string, Record<string, string>>,
  ) => {
    for (const supportsContext of [true, false]) {
      expect(
        planBundleTranslation({
          bundle: formsBundle(declarations, selectors, messages),
          sourceLocale: "en",
          targetLocales: ["ar"],
          supportsContext,
        }),
      ).toMatchObject({ missing: [] });
    }
  };
  const arabic = (prefix: string) =>
    Object.fromEntries(
      ["zero", "one", "two", "few", "many", "*"].map((category) => [
        `${prefix}countPlural=${category}`,
        `[ar] ${category}`,
      ]),
    );
  // English `_zero`, `_one`, `_other`
  nothingMissing(countPlural, ["count", "countPlural"], {
    en: {
      "count=0,countPlural=*": "No items",
      "count=*,countPlural=one": "One item",
      "count=*,countPlural=*": "Many items",
    },
    ar: arabic("count=*,"),
  });
  // with `_ordinal_other` too
  nothingMissing(
    [
      input("count"),
      input("pluralType"),
      plural("countPlural", "count", { type: "$pluralType" }),
    ],
    ["pluralType", "count", "countPlural"],
    {
      en: {
        "pluralType=cardinal,count=0,countPlural=*": "No items",
        "pluralType=*,count=*,countPlural=one": "One item",
        "pluralType=*,count=*,countPlural=*": "Many items",
        "pluralType=ordinal,count=*,countPlural=*": "Nth",
      },
      ar: {
        ...arabic("pluralType=*,count=*,"),
        "pluralType=ordinal,count=*,countPlural=*": "[ar] Nth",
      },
    },
  );
});

test("two plurals: the context identifies each input and category", async () => {
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
  expect(calls[6]!.context).toBe(
    `${fewInRu}\n${manyInRu.replace("{count}", "{guests}")}`,
  );
});

test("a form whose numbers are several categories in the source is translated from its catch-all", () => {
  // Arabic `few` (3–10) is Russian `few` and `many`, despite the name
  const plan = planBundleTranslation({
    bundle: formsBundle(countPlural, ["countPlural"], {
      ru: {
        "countPlural=one": "Один товар",
        "countPlural=few": "Несколько товаров",
        "countPlural=many": "Много товаров",
        "countPlural=*": "Товары",
      },
    }),
    sourceLocale: "ru",
    targetLocales: ["ar"],
    supportsContext: true,
  });
  if ("error" in plan) throw Error(plan.error);
  const few = plan.missing.find((translation) =>
    translation.matches.some(
      (match) => match.type === "literal-match" && match.value === "few",
    ),
  )!;
  expect(few.text).toBe("Товары");
  expect(few.context).toBe(
    "Plural form for {count}: few (cardinal) in ar, used for n = 3–10, 103…. Translate as the few form; the source shows the other form.",
  );
});

test("an exact-number form is not described as the plural catch-all", async () => {
  const { calls } = await expand(
    formsBundle(countPlural, ["count", "countPlural"], {
      en: {
        "count=0,countPlural=*": "No items",
        "count=*,countPlural=one": "One item",
        "count=*,countPlural=*": "Items",
      },
    }),
    ["ar"],
  );
  expect(calls.find((call) => call.text === "No items")?.context).toBe(
    "Exact-number form for {count}: 0 in ar. Preserve this exact-number meaning.",
  );
});

test("with context, a blank form is filled unless its source is blank too", async () => {
  // a whitespace-only form is missing too, as `inlang check` reports it, but
  // not one whose source is blank as well: a translation can't fill it
  const blank = await expand(
    formsBundle(countPlural, ["countPlural"], {
      en: { "countPlural=one": " ", "countPlural=*": "Many items" },
      de: { "countPlural=one": "", "countPlural=other": " \n " },
    }),
    ["de"],
  );
  expect(Object.entries(formsOf(blank.result, "de")!)).toEqual([
    ["countPlural=one", ""],
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
    // the catch-all type is cardinal, whose Russian `one` is also 21, 31…
    ["pluralType=*,count=*,countPlural=one", "[ru] Items"],
    ["pluralType=*,count=*,countPlural=few", "[ru] Items"],
    ["pluralType=*,count=*,countPlural=many", "[ru] Items"],
    ["pluralType=*,count=*,countPlural=other", "[ru] Items"],
  ]);
  expect(
    calls.find(
      (call) =>
        call.targetLocale === "ru" &&
        call.context?.includes("Plural form for {count}: one (cardinal)"),
    )?.context,
  ).toContain("21");
  // Welsh `zero` is an ordinal and a cardinal form, each of its type
  expect(
    calls.flatMap((call) =>
      call.targetLocale === "cy" && call.context?.includes("zero")
        ? [call.context]
        : [],
    ),
  ).toEqual([
    "Plural form for {count}: zero (ordinal) in cy, used for n = 0, 7–9. Translate as the zero form; the source shows the other form.",
    "Plural form for {count}: zero (cardinal) in cy, used for n = 0. Translate as the zero form; the source shows the other form.",
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
    "Plural form for {count}: few (cardinal) in ru, used for n = 3–5, 23…. Translate as the few form; the source shows the other form.",
  );

  const underscore = await expand(
    formsBundle(countPlural, ["countPlural"], { en: items }),
    ["ru_RU"],
  );
  expect(underscore.calls[1]!.context).toBe(
    "Plural form for {count}: few (cardinal) in ru_RU, used for n = 2–4, 22…. Translate as the few form; the source shows the other form.",
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

test("a plural whose type no selector chooses has unknown rules: the source's forms are copied", async () => {
  const { result } = await expand(
    formsBundle(
      [
        input("count"),
        input("pluralType"),
        plural("countPlural", "count", { type: "$pluralType" }),
      ],
      ["countPlural"],
      { en: items },
    ),
    ["de"],
  );

  expect(result.unknownPluralRules).toEqual(["de"]);
  expect(formsOf(result, "de")).toEqual({
    "countPlural=one": "[de] One item",
    "countPlural=*": "[de] Many items",
  });
});

// Native MF2 may give the cardinal type its own categories. The SDK's plan follows i18next,
// where cardinal categories live under the catch-all type, so expanding would drop these.
test("cardinal categories under an explicit type branch: the source's forms are copied", async () => {
  const { result } = await expand(
    formsBundle(
      [
        input("count"),
        input("pluralType"),
        plural("countPlural", "count", { type: "$pluralType" }),
      ],
      ["pluralType", "countPlural"],
      {
        en: {
          "pluralType=cardinal,countPlural=one": "One item",
          "pluralType=cardinal,countPlural=*": "Many items",
          "pluralType=*,countPlural=one": "First place",
          "pluralType=*,countPlural=*": "Other place",
        },
      },
    ),
    ["de"],
  );

  expect(result.unknownPluralRules).toEqual(["de"]);
  expect(formsOf(result, "de")).toEqual({
    "pluralType=cardinal,countPlural=one": "[de] One item",
    "pluralType=cardinal,countPlural=*": "[de] Many items",
    "pluralType=*,countPlural=one": "[de] First place",
    "pluralType=*,countPlural=*": "[de] Other place",
  });
});

test("a selector a source form leaves out is its catch-all: that branch is kept too", async () => {
  const { result } = await expand(
    formsBundle(
      [
        input("count"),
        input("pluralType"),
        plural("countPlural", "count", { type: "$pluralType" }),
      ],
      ["count", "pluralType", "countPlural"],
      {
        en: {
          "count=0,pluralType=cardinal,countPlural=*": "No items",
          "pluralType=cardinal,countPlural=one": "One item",
          "pluralType=cardinal,countPlural=*": "Many items",
          "pluralType=*,countPlural=one": "First place",
          "pluralType=*,countPlural=*": "Other place",
        },
      },
    ),
    ["de"],
  );

  expect(result.unknownPluralRules).toEqual(["de"]);
  expect(Object.values(formsOf(result, "de")!)).toEqual([
    "[de] No items",
    "[de] One item",
    "[de] Many items",
    "[de] First place",
    "[de] Other place",
  ]);
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
        "3": { text: "Many items", context: otherInRu },
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

  expect(result.rejected).toEqual(
    Array(6).fill({ locale: "ru", reasons: ["{count}"] }),
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

test("a select value only the target has: the source's forms are copied, as added forms would take its numbers", async () => {
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

  // `few, *` would take 2 from the hand-written `*, neuter`, and nothing can
  // be translated for `few, neuter`
  expect(calls.map((call) => call.text)).toEqual(["One item"]);
  expect(Object.entries(formsOf(result, "ru")!)).toEqual([
    ["countPlural=*,gender=neuter", "Оно"],
    ["countPlural=one,gender=*", "[ru] One item"],
    ["countPlural=*,gender=*", "Товары"],
  ]);
  expect(result.incompletePlurals).toEqual([
    { locale: "ru", categories: ["few", "many"] },
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

test("a target whose selectors aren't the source's isn't expanded: reported and left as it is", async () => {
  // a target with a gender the source doesn't select
  const bundle = formsBundle(
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
  bundle.messages[1]!.selectors.push({
    type: "variable-reference",
    name: "gender",
  });
  const ru = formsOf({ data: bundle }, "ru");
  const { calls, result } = await expand(bundle, ["ru"]);

  expect(calls).toEqual([]);
  expect(result.incompletePlurals).toEqual([
    { locale: "ru", categories: ["few", "many"] },
  ]);
  expect(formsOf(result, "ru")).toEqual(ru);
});

test("an empty form the target has is translated even when its language doesn't require it", async () => {
  // French `many` is for millions, which the SDK doesn't require; left empty,
  // a million shows a blank.
  const bundle = formsBundle(countPlural, ["countPlural"], {
    es: {
      "countPlural=one": "Un artículo",
      "countPlural=many": "Un millón de artículos",
      "countPlural=*": "Artículos",
    },
    fr: {
      "countPlural=one": "Un article",
      "countPlural=many": "",
      "countPlural=*": "Articles",
    },
  });
  const { calls, provider } = recordingProvider(true);
  const result = await machineTranslateBundle({
    bundle,
    sourceLocale: "es",
    targetLocales: ["fr"],
    provider,
  });

  expect(calls.map((call) => call.text)).toEqual(["Un millón de artículos"]);
  expect(formsOf(result, "fr")).toEqual({
    "countPlural=one": "Un article",
    "countPlural=many": "[fr] Un millón de artículos",
    "countPlural=*": "Articles",
  });
});

test("an empty Arabic `zero` is translated once, from the exact 0 form", async () => {
  const { calls, result } = await expand(
    formsBundle(countPlural, ["count", "countPlural"], {
      en: {
        "count=0,countPlural=*": "No items",
        "count=*,countPlural=one": "One item",
        "count=*,countPlural=*": "Items",
      },
      ar: {
        "count=*,countPlural=zero": "",
        ...Object.fromEntries(
          ["one", "two", "few", "many", "*"].map((category) => [
            `count=*,countPlural=${category}`,
            `[ar] ${category}`,
          ]),
        ),
      },
    }),
    ["ar"],
  );

  expect(calls.map((call) => call.text)).toEqual(["No items"]);
  expect(formsOf(result, "ar")!["count=*,countPlural=zero"]).toBe(
    "[ar] No items",
  );
});

test("an empty Arabic `zero` with ordinal forms too is translated once, from the exact 0 form", async () => {
  const { calls, result } = await expand(
    formsBundle(
      [
        input("count"),
        input("pluralType"),
        plural("countPlural", "count", { type: "$pluralType" }),
      ],
      ["pluralType", "count", "countPlural"],
      {
        en: {
          "pluralType=cardinal,count=0,countPlural=*": "No items",
          "pluralType=*,count=*,countPlural=one": "One item",
          "pluralType=*,count=*,countPlural=*": "Items",
          "pluralType=ordinal,count=*,countPlural=*": "Nth",
        },
        ar: {
          "pluralType=*,count=*,countPlural=zero": "",
          ...Object.fromEntries(
            ["one", "two", "few", "many", "*"].map((category) => [
              `pluralType=*,count=*,countPlural=${category}`,
              `[ar] ${category}`,
            ]),
          ),
          "pluralType=ordinal,count=*,countPlural=*": "[ar] Nth",
        },
      },
    ),
    ["ar"],
  );

  expect(calls.map((call) => call.text)).toEqual(["No items"]);
  expect(formsOf(result, "ar")!["pluralType=*,count=*,countPlural=zero"]).toBe(
    "[ar] No items",
  );
});

test("an empty form its language never selects is left alone", async () => {
  // German never selects `zero`, as from an empty i18next `_zero`
  const { calls } = await expand(
    formsBundle(countPlural, ["countPlural"], {
      en: items,
      de: {
        "countPlural=zero": "",
        "countPlural=one": "Ein Artikel",
        "countPlural=*": "Artikel",
      },
    }),
    ["de"],
  );
  expect(calls).toEqual([]);
});

test("a form the source has is added where the target's language selects it", async () => {
  // French and Spanish `many` is for millions, which the SDK doesn't require
  const bundle = formsBundle(countPlural, ["countPlural"], {
    es: {
      "countPlural=one": "Un artículo",
      "countPlural=many": "Un millón de artículos",
      "countPlural=*": "Artículos",
    },
  });
  const { calls, provider } = recordingProvider(true);
  const result = await machineTranslateBundle({
    bundle,
    sourceLocale: "es",
    targetLocales: ["fr", "de"],
    provider,
  });

  expect(Object.entries(formsOf(result, "fr")!)).toEqual([
    // French `one` is 0 and 1, so it comes from `*`
    ["countPlural=one", "[fr] Artículos"],
    ["countPlural=many", "[fr] Un millón de artículos"],
    ["countPlural=*", "[fr] Artículos"],
  ]);
  // German never selects `many`
  expect(formsOf(result, "de")).toEqual({
    "countPlural=one": "[de] Un artículo",
    "countPlural=*": "[de] Artículos",
  });
  expect(calls).toHaveLength(5);
});

test("a form the source has goes before the catch-all of a target that has the others", async () => {
  const bundle = formsBundle(countPlural, ["countPlural"], {
    es: {
      "countPlural=one": "Un artículo",
      "countPlural=many": "Un millón de artículos",
      "countPlural=*": "Artículos",
    },
    fr: { "countPlural=one": "Un article", "countPlural=*": "Articles" },
  });
  const { provider } = recordingProvider(true);
  const result = await machineTranslateBundle({
    bundle,
    sourceLocale: "es",
    targetLocales: ["fr"],
    provider,
  });

  expect(Object.entries(formsOf(result, "fr")!)).toEqual([
    ["countPlural=one", "Un article"],
    ["countPlural=many", "[fr] Un millón de artículos"],
    ["countPlural=*", "Articles"],
  ]);
});

test("a blank catch-all is copied, so a new message matches every number", async () => {
  const bundle = pluralBundle([]);
  bundle.messages[0]!.variants[1]!.pattern = [];
  bundle.messages.pop();
  const texts: string[] = [];
  const result = await machineTranslateBundle({
    bundle,
    sourceLocale: "en",
    targetLocales: ["de"],
    provider: {
      translateText: async ({ text }) => {
        texts.push(text);
        return { ok: true, translatedText: "Ein Ding" };
      },
    },
  });

  expect(texts).toEqual(["One item"]);
  const translated = result.data!.messages.find((m) => m.locale === "de")!;
  expect(valuesOf(translated)).toEqual(["one", "*"]);
  expect(translated.variants[1]!.pattern).toEqual([]);
});

test("copied blank sources count toward progress", async () => {
  const bundle = pluralBundle([]);
  bundle.messages[0]!.variants[0]!.pattern = [];
  bundle.messages.pop();
  const plan = planBundleTranslation({
    bundle,
    sourceLocale: "en",
    targetLocales: ["de"],
  });
  if ("error" in plan) throw new Error(plan.error);
  let progress = 0;
  await translateMissing({
    provider: {
      translateText: async () => ({ ok: true, translatedText: "Viele Dinge" }),
    },
    sourceLocale: "en",
    missing: plan.missing,
    onProgress: (count) => (progress += count),
  });

  expect(progress).toBe(plan.missing.length);
});

test.each<[string, Record<string, string> | undefined]>([
  ["a new message", undefined],
  ["a message without that form", { "countPlural=*": "Dinge" }],
])(
  "an expanded plural copies a blank source instead of sending it, for %s",
  async (_, de) => {
    const bundle = formsBundle(countPlural, ["countPlural"], {
      en: { "countPlural=one": "", "countPlural=*": "Many items" },
      ...(de && { de }),
    });
    const { calls, result } = await expand(bundle, ["de"]);

    // German `one` comes from the blank English `one`: it is copied, blank
    expect(calls.map((call) => call.text)).toEqual(de ? [] : ["Many items"]);
    expect(formsOf(result, "de")).toEqual({
      "countPlural=one": "",
      "countPlural=*": de ? "Dinge" : "[de] Many items",
    });
  },
);

test("a message without forms isn't filled when one of its translations is rejected", async () => {
  const bundle = withPlaceholders(
    formsBundle(countPlural, ["countPlural"], { en: itemCount, fr: {} }),
  );
  // as an editor adds it
  bundle.messages[1]!.selectors = [];
  const result = await translateEditing(bundle, ["fr"], (text) =>
    text.endsWith(" item") ? dropPlaceholders(text) : text,
  );

  expect(result.rejected).toEqual([
    { locale: "fr", reasons: ["{count}"] },
    { locale: "fr", reasons: [] },
  ]);
  const fr = result.data!.messages.find((m) => m.locale === "fr")!;
  expect(fr.variants).toEqual([]);
});

test("a translation that isn't text, such as {}, fails instead of being saved blank", async () => {
  const bundle = pluralBundle([]);
  bundle.messages.pop();
  const plan = planBundleTranslation({
    bundle,
    sourceLocale: "en",
    targetLocales: ["de"],
  });
  if ("error" in plan) throw new Error(plan.error);
  const result = await translateMissing({
    provider: {
      translateBatch: async ({ texts }) => ({
        ok: true,
        translatedTexts: Object.fromEntries(
          Object.keys(texts).map((key) => [key, {} as never]),
        ),
      }),
    },
    sourceLocale: "en",
    missing: plan.missing,
  });

  expect(result).toMatchObject({
    ok: false,
    error: 'The translation of "One item" isn\'t text.',
  });
  expect(result.translations.size).toBe(0);
});

test("a translation's `other` doesn't replace the source's catch-all", async () => {
  // Paraglide selects a literal `other` only for its category, which in
  // Russian is fractions: 2 and 5 need the catch-all
  const { calls, result } = await translate(
    formsBundle(countPlural, ["countPlural"], {
      en: items,
      ru: { "countPlural=one": "Один товар", "countPlural=other": "Товара" },
    }),
    ["ru"],
  );

  expect(calls.map((call) => call.text)).toEqual(["Many items"]);
  expect(formsOf(result, "ru")).toEqual({
    "countPlural=one": "Один товар",
    "countPlural=other": "Товара",
    "countPlural=*": "[ru] Many items",
  });
  expect(result.incompletePlurals).toEqual([
    { locale: "ru", categories: ["few", "many"] },
  ]);
});

test("an empty select value only the translation has is reported", async () => {
  // a source without selectors, and a hand-written translation by gender
  const bundle = formsBundle([input("gender")], ["gender"], {
    en: { "gender=*": "Hello" },
    de: { "gender=female": "", "gender=*": "Hallo" },
  });
  const en = bundle.messages.find((message) => message.locale === "en")!;
  en.selectors = [];
  en.variants[0]!.matches = [];
  const { calls, result } = await translate(bundle, ["de"]);

  expect(calls).toEqual([]);
  expect(result.differentSelectors).toEqual(["de"]);
});

test("an empty form next to a filled catch-all is reported", async () => {
  // German `other` is selected for 2 before the catch-all
  const bundle = formsBundle(countPlural, ["countPlural"], {
    en: { "countPlural=*": "Items" },
    de: {
      "countPlural=one": "Ein Ding",
      "countPlural=other": "",
      "countPlural=*": "Dinge",
    },
  });
  const en = bundle.messages.find((message) => message.locale === "en")!;
  en.selectors = [];
  en.variants[0]!.matches = [];
  const { calls, result } = await translate(bundle, ["de"]);

  expect(calls).toEqual([]);
  expect(result.differentSelectors).toEqual(["de"]);
});
