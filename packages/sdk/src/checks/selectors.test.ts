import { expect, test } from "vitest";
import type { Declaration } from "../json-schema/pattern.js";
import type { Match } from "../database/schema.js";
import {
	missingVariants,
	pluralRules,
	requiredVariants,
	resolveInputVariable,
	selectorGroups,
	sourceVariantFor,
} from "./selectors.js";

const plural: Declaration[] = [
	{ type: "input-variable", name: "count" },
	{
		type: "local-variable",
		name: "countPlural",
		value: {
			type: "expression",
			arg: { type: "variable-reference", name: "count" },
			annotation: { type: "function-reference", name: "plural", options: [] },
		},
	},
];
const genderPlural: Declaration[] = [
	{ type: "input-variable", name: "gender" },
	...plural,
];
/** What `@inlang/plugin-icu1` imports for `{count, plural, =0 {…} one {…} other {…}}`. */
const icuExact: Declaration[] = [
	...plural,
	{
		type: "local-variable",
		name: "countPluralExact",
		value: {
			type: "expression",
			arg: { type: "variable-reference", name: "count" },
		},
	},
];

/** What `@inlang/plugin-i18next` imports for keys with cardinal and ordinal forms. */
const typedPlural: Declaration[] = [
	{ type: "input-variable", name: "count" },
	{ type: "input-variable", name: "pluralType" },
	{
		type: "local-variable",
		name: "countPlural",
		value: {
			type: "expression",
			arg: { type: "variable-reference", name: "count" },
			annotation: {
				type: "function-reference",
				name: "plural",
				options: [
					{
						name: "type",
						value: { type: "variable-reference", name: "pluralType" },
					},
				],
			},
		},
	},
];

const variant = (values: Record<string, string>) => ({
	matches: Object.entries(values).map(
		([key, value]): Match =>
			value === "*"
				? { type: "catchall-match", key }
				: { type: "literal-match", key, value }
	),
});
const message = (
	locale: string,
	selectors: string[],
	variants: Record<string, string>[] = []
) => ({
	locale,
	selectors: selectors.map((name) => ({
		type: "variable-reference" as const,
		name,
	})),
	variants: variants.map(variant),
});
const values = (forms: Match[][]) =>
	forms.map((form) =>
		form
			.map((match) => (match.type === "literal-match" ? match.value : "*"))
			.join(" · ")
	);

const icuEnglish = message(
	"en",
	["countPluralExact", "countPlural"],
	[
		{ countPluralExact: "0", countPlural: "*" },
		{ countPluralExact: "*", countPlural: "one" },
		{ countPluralExact: "*", countPlural: "*" },
	]
);

test("a message without selectors needs one form without matches", () => {
	expect(requiredVariants(message("en", []), [])).toEqual([[]]);
});

test("plural categories follow the locale in CLDR order, ordinals too", () => {
	expect(
		values(requiredVariants(message("ru", ["countPlural"]), plural))
	).toEqual(["one", "few", "many", "*"]);
	const ordinal = structuredClone(plural);
	const local = ordinal[1]!;
	if (local.type === "local-variable")
		local.value.annotation!.options.push({
			name: "type",
			value: { type: "literal", value: "ordinal" },
		});
	expect(
		values(requiredVariants(message("en", ["countPlural"]), ordinal))
	).toEqual(["one", "two", "few", "*"]);
	expect(pluralRules("countPlural", ordinal, "en")?.type).toBe("ordinal");
});

test("an ICU offset keeps the plural rules known and is reported", () => {
	const withOptions = (options: { name: string; value: string }[]) => {
		const declarations = structuredClone(plural);
		const local = declarations[1]!;
		if (local.type === "local-variable")
			local.value.annotation!.options = options.map(({ name, value }) => ({
				name,
				value: { type: "literal", value },
			}));
		return declarations;
	};
	const offset = pluralRules(
		"countPlural",
		withOptions([{ name: "offset", value: "1" }]),
		"en"
	);
	expect(offset).toMatchObject({ offset: 1, categories: ["one", "other"] });
	expect(pluralRules("countPlural", plural, "en")?.offset).toBe(0);
	// an offset that is only known at runtime: unknown rules
	expect(
		pluralRules(
			"countPlural",
			withOptions([{ name: "offset", value: "n" }]),
			"en"
		)
	).toBeUndefined();
});

test("the cartesian product uses the literal values of a select and the catch-all", () => {
	const forms = requiredVariants(
		message(
			"ru",
			["gender", "countPlural"],
			[
				{ gender: "female", countPlural: "one" },
				{ gender: "male", countPlural: "*" },
			]
		),
		genderPlural
	);
	expect(forms).toHaveLength(12);
	expect(values(forms).slice(0, 5)).toEqual([
		"female · one",
		"female · few",
		"female · many",
		"female · *",
		"male · one",
	]);
	expect(forms.at(-1)![0]).toEqual({ type: "catchall-match", key: "gender" });
});

test("plurals with unknown rules need only the catch-all", () => {
	const m = message("zz", ["countPlural"], [{ countPlural: "one" }]);
	expect(values(requiredVariants(m, plural))).toEqual(["*"]);
	expect(selectorGroups(m, plural)[0]!.keys).toEqual(["one", "*"]);
});

test("an ICU exact number and the plural of the same input are one choice", () => {
	const groups = selectorGroups(icuEnglish, icuExact);
	expect(groups).toHaveLength(1);
	const group = groups[0]!;
	expect(group).toMatchObject({
		names: ["countPluralExact", "countPlural"],
		selector: "countPlural",
		exactSelector: "countPluralExact",
		input: "count",
		isPlural: true,
		plural: { type: "cardinal", categories: ["one", "other"] },
		keys: ["0", "one", "*"],
		requiredKeys: ["0", "one", "*"],
	});
	expect(group.values("0")).toEqual({
		countPluralExact: "0",
		countPlural: "*",
	});
	expect(group.values("one")).toEqual({
		countPluralExact: "*",
		countPlural: "one",
	});
	expect(icuEnglish.variants.map(group.keyOf)).toEqual(["0", "one", "*"]);
	// "0 · one" is never a form
	expect(values(requiredVariants(icuEnglish, icuExact))).toEqual([
		"0 · *",
		"* · one",
		"* · *",
	]);
	expect(missingVariants(icuEnglish, icuExact)).toEqual([]);
	expect(
		values(
			missingVariants({ ...icuEnglish, locale: "ru" }, icuExact, {
				referenceVariants: icuEnglish.variants,
			})
		)
	).toEqual(["* · few", "* · many"]);
});

test("the pair is found in either order, and a select with words on the input stays apart", () => {
	const after = message(
		"en",
		["countPlural", "count"],
		[
			{ count: "0", countPlural: "*" },
			{ count: "*", countPlural: "one" },
		]
	);
	expect(selectorGroups(after, plural).map((group) => group.names)).toEqual([
		["countPlural", "count"],
	]);
	expect(values(requiredVariants(after, plural))).toEqual([
		"* · 0",
		"one · *",
		"* · *",
	]);
	const words = message(
		"en",
		["count", "countPlural"],
		[{ count: "many", countPlural: "*" }]
	);
	expect(selectorGroups(words, plural).map((group) => group.names)).toEqual([
		["count"],
		["countPlural"],
	]);
});

test("a translation needs the reference's select values and exact numbers, not its plural categories", () => {
	const reference = [
		variant({ gender: "female" }),
		variant({ gender: "male" }),
		variant({ gender: "*" }),
	];
	const german = message("de", ["gender"]);
	expect(values(requiredVariants(german, genderPlural))).toEqual(["*"]);
	expect(
		values(
			requiredVariants(german, genderPlural, { referenceVariants: reference })
		)
	).toEqual(["female", "male", "*"]);
	// the reference's order first, then values only the translation has
	expect(
		selectorGroups(
			message("de", ["gender"], [{ gender: "diverse" }, { gender: "female" }]),
			genderPlural,
			{ referenceVariants: reference }
		)[0]!.keys
	).toEqual(["female", "male", "diverse", "*"]);
	expect(
		values(
			requiredVariants(message("de", ["countPlural"]), plural, {
				referenceVariants: [variant({ countPlural: "few" })],
			})
		)
	).toEqual(["one", "*"]);
	expect(
		values(
			missingVariants(
				message(
					"de",
					["countPluralExact", "countPlural"],
					[{ countPluralExact: "*", countPlural: "*" }]
				),
				icuExact,
				{ referenceVariants: icuEnglish.variants }
			)
		)
	).toEqual(["0 · *", "* · one"]);
});

test("an exact number and the plural category that selects only it are one form", () => {
	// what `@inlang/plugin-i18next` imports for English `_zero`, `_one`, `_other`
	const english = [
		variant({ count: "0", countPlural: "*" }),
		variant({ count: "*", countPlural: "one" }),
		variant({ count: "*", countPlural: "*" }),
	];
	// Arabic "zero" selects only 0, so it is the exact form: the plugin imports
	// Arabic `_zero` as "zero"
	expect(
		missingVariants(
			message(
				"ar",
				["count", "countPlural"],
				["zero", "one", "two", "few", "many", "*"].map((category) => ({
					count: "*",
					countPlural: category,
				}))
			),
			plural,
			{ referenceVariants: english }
		)
	).toEqual([]);
	// with ordinal forms too: English `_zero` is the exact 0 of the cardinal
	// type, Arabic `_zero` the "zero" of the catch-all type, which is cardinal
	expect(
		missingVariants(
			message(
				"ar",
				["pluralType", "count", "countPlural"],
				[
					...["zero", "one", "two", "few", "many", "*"].map((category) => ({
						pluralType: "*",
						count: "*",
						countPlural: category,
					})),
					{ pluralType: "ordinal", count: "*", countPlural: "*" },
				]
			),
			typedPlural,
			{
				referenceVariants: [
					variant({ pluralType: "cardinal", count: "0", countPlural: "*" }),
					variant({ pluralType: "*", count: "*", countPlural: "one" }),
					variant({ pluralType: "*", count: "*", countPlural: "*" }),
					variant({ pluralType: "ordinal", count: "*", countPlural: "one" }),
					variant({ pluralType: "ordinal", count: "*", countPlural: "*" }),
				],
			}
		)
	).toEqual([]);
	// German "one" also selects -1: ICU `=1` doesn't stand in for it
	expect(
		values(
			requiredVariants(
				message("de", ["countPluralExact", "countPlural"]),
				icuExact,
				{
					referenceVariants: [
						variant({ countPluralExact: "1", countPlural: "*" }),
						variant({ countPluralExact: "*", countPlural: "*" }),
					],
				}
			)
		)
	).toEqual(["1 · *", "* · one", "* · *"]);
	const offset = structuredClone(icuExact);
	const local = offset[1]!;
	if (local.type === "local-variable")
		local.value.annotation!.options = [
			{ name: "offset", value: { type: "literal", value: "1" } },
		];
	// with `offset:1`, Arabic "zero" is `=1`, not `=0`
	const arabicMissing = (number: string) =>
		values(
			missingVariants(
				message(
					"ar",
					["countPluralExact", "countPlural"],
					["zero", "one", "two", "few", "many", "*"].map((category) => ({
						countPluralExact: "*",
						countPlural: category,
					}))
				),
				offset,
				{
					referenceVariants: [
						variant({ countPluralExact: number, countPlural: "*" }),
						variant({ countPluralExact: "*", countPlural: "*" }),
					],
				}
			)
		);
	expect(arabicMissing("1")).toEqual([]);
	expect(arabicMissing("0")).toEqual(["0 · *"]);
});

test("an explicit other covers the catch-all, a missing match counts as catch-all", () => {
	expect(
		missingVariants(
			message(
				"en",
				["countPlural"],
				[{ countPlural: "one" }, { countPlural: "other" }]
			),
			plural
		)
	).toEqual([]);
	// ICU `{gender, select, female {{count, plural, …}} other {…}}`: the catch-all has no plural match
	expect(
		values(
			missingVariants(
				message(
					"en",
					["gender", "countPlural"],
					[
						{ gender: "female", countPlural: "one" },
						{ gender: "female", countPlural: "*" },
						{ gender: "*" },
					]
				),
				genderPlural
			)
		)
	).toEqual(["* · one"]);
});

test("resolveInputVariable follows local aliases", () => {
	expect(resolveInputVariable("countPluralExact", icuExact)).toBe("count");
	expect(resolveInputVariable("count", icuExact)).toBe("count");
	expect(resolveInputVariable("unknown", icuExact)).toBe("unknown");
});

/** Each form a translation needs, with the reference variant it is translated from. */
const sources = (
	translation: ReturnType<typeof message>,
	declarations: Declaration[],
	reference: { matches: Match[] }[],
	referenceLocale = "en"
) =>
	requiredVariants(translation, declarations, {
		referenceVariants: reference,
	}).map((form) => {
		const source = sourceVariantFor(
			form,
			reference,
			declarations,
			referenceLocale,
			translation.locale
		);
		return `${values([form])} <- ${source ? values([source.matches]) : "none"}`;
	});

test("of the variants that hold, the one with literal keys on earlier selectors is shown, as at runtime", () => {
	// "You have one free trial left" / "He has paid credits" / "Paid credits remaining":
	// Paraglide shows the first for count 1 and male
	const english = [
		variant({ countPlural: "one", gender: "*" }),
		variant({ countPlural: "*", gender: "male" }),
		variant({ countPlural: "*", gender: "*" }),
	];
	expect(
		sources(message("de", ["countPlural", "gender"]), genderPlural, english)
	).toEqual([
		"one · male <- one · *",
		"one · * <- one · *",
		"* · male <- * · male",
		"* · * <- * · *",
	]);
	// Russian `one` (1, 21, 31…) and `few` are `other` in English: 21 and male shows `* · male`
	expect(
		sources(message("ru", ["countPlural", "gender"]), genderPlural, english)
	).toEqual([
		"one · male <- * · male",
		"one · * <- * · *",
		"few · male <- * · male",
		"few · * <- * · *",
		"many · male <- * · male",
		"many · * <- * · *",
		"* · male <- * · male",
		"* · * <- * · *",
	]);
	// the selector order decides: with gender first, male 1 shows `male · *`
	const genderFirst = [
		variant({ gender: "*", countPlural: "one" }),
		variant({ gender: "male", countPlural: "*" }),
		variant({ gender: "*", countPlural: "*" }),
	];
	expect(
		sources(message("de", ["gender", "countPlural"]), genderPlural, genderFirst)
	).toEqual([
		"male · one <- male · *",
		"male · * <- male · *",
		"* · one <- * · one",
		"* · * <- * · *",
	]);
});

test("an exact number's variant the reference never shows is not a source", () => {
	// English 0 is `other`, so English never shows `0 · zero`
	const english = [
		variant({ countPluralExact: "0", countPlural: "zero" }),
		variant({ countPluralExact: "0", countPlural: "*" }),
		variant({ countPluralExact: "*", countPlural: "*" }),
	];
	const form = variant({ countPluralExact: "0", countPlural: "*" }).matches;
	expect(sourceVariantFor(form, english, icuExact, "en", "de")).toBe(
		english[1]
	);
});

test("a select value only a variant the reference never shows uses still has its source", () => {
	// English never shows `zero · male`, so male counts show its catch-all
	const english = [
		variant({ countPlural: "zero", gender: "male" }),
		variant({ countPlural: "*", gender: "*" }),
	];
	expect(
		sourceVariantFor(
			variant({ countPlural: "one", gender: "male" }).matches,
			english,
			genderPlural,
			"en",
			"de"
		)
	).toBe(english[1]);
});

test("exact numbers and select values are never substituted", () => {
	expect(
		sources({ ...icuEnglish, locale: "pl" }, icuExact, icuEnglish.variants)
	).toEqual([
		"0 · * <- 0 · *",
		"* · one <- * · one",
		"* · few <- * · *",
		"* · many <- * · *",
		"* · * <- * · *",
	]);
	// a select value only the translation uses has no source
	expect(
		sources(message("ru", ["gender"], [{ gender: "diverse" }]), genderPlural, [
			variant({ gender: "female" }),
			variant({ gender: "*" }),
		])
	).toEqual(["female <- female", "diverse <- none", "* <- *"]);
});

test("a plural whose type is a variable spells out one number in the type the form matches", () => {
	// "One item": the catch-all type is cardinal, where Russian `one` is 1, 21, 31…
	const english = [
		variant({ pluralType: "*", countPlural: "one" }),
		variant({ pluralType: "*", countPlural: "other" }),
	];
	expect(
		sources(message("ru", ["pluralType", "countPlural"]), typedPlural, english)
	).toEqual([
		"* · one <- * · other",
		"* · few <- * · other",
		"* · many <- * · other",
		"* · * <- * · other",
	]);
});
