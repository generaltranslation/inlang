import { expect, test } from "vitest";
import type {
  BundleNested,
  Declaration,
  NewBundleNested,
  Pattern,
} from "@inlang/sdk";
import { planBundleTranslation } from "./machineTranslateBundle.js";
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

/** A provider that records the texts and translates `text` to `[locale] text`. */
function recordingProvider() {
  const calls: string[] = [];
  return {
    calls,
    provider: {
      translateText: async (args: { text: string; targetLocale: string }) => {
        calls.push(args.text);
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
  const message = result.data!.messages.find((m) => m.locale === locale)!;
  return Object.fromEntries(
    message.variants.map((variant) => [
      variant
        .matches!.map(
          (match) =>
            `${match.key}=${match.type === "literal-match" ? match.value : "*"}`,
        )
        .join(","),
      (variant.pattern![0] as { value: string } | undefined)?.value ?? "",
    ]),
  );
}

async function translate(bundle: BundleNested, targetLocales: string[]) {
  const { calls, provider } = recordingProvider();
  const args = { bundle, sourceLocale: "en", targetLocales };
  const plan = planBundleTranslation(args);
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
  expect(calls).toEqual(["She has one item", "She has items"]);
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
  // the source's text wouldn't fit the plural: it is left as it is
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
  expect(Object.entries(formsOf(catchAll.result, "de"))).toEqual([
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
  expect(Object.entries(formsOf(emptyOther.result, "de"))).toEqual([
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
  expect(selectOther.calls).toEqual(["They"]);

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
  expect(Object.entries(formsOf(partialPlural.result, "de"))).toEqual([
    ["countPlural=one", "Ein Ding"],
    ["countPlural=other", "Dinge"],
    ["countPlural=*", "[de] Some items"],
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
) {
  return machineTranslateBundle({
    bundle,
    sourceLocale: "en",
    targetLocales,
    provider: {
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
