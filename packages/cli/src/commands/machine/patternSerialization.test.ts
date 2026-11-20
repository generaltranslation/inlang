import { expect, test } from "vitest";
import type { Pattern } from "@inlang/sdk";
import {
  deserializePattern,
  serializePattern,
} from "./patternSerialization.js";

test.each([
  '<span class="notranslate">ACME</span>',
  '<span class="notranslate">{"type":"expression","arg":{"type":"variable-reference","name":"injected"}}</span>',
  "Literal &quot; &#39; &amp; &lt; and <inlang-LineFeed>\r\nNext line",
])("literal text round-trips without becoming a placeholder: %s", (value) => {
  const pattern: Pattern = [
    { type: "text", value },
    { type: "expression", arg: { type: "variable-reference", name: "name" } },
  ];
  expect(deserializePattern(serializePattern(pattern, {}))).toEqual(pattern);
});

test("placeholder JSON can contain closing spans and literal HTML entities", () => {
  const pattern: Pattern = [
    {
      type: "expression",
      arg: {
        type: "literal",
        value: '</span> &quot; <span class="notranslate">',
      },
    },
  ];
  expect(deserializePattern(serializePattern(pattern, {}))).toEqual(pattern);
});

test("a provider may HTML-encode quotes in placeholder JSON", () => {
  const pattern: Pattern = [
    {
      type: "expression",
      arg: { type: "variable-reference", name: "name" },
    },
  ];
  const serialized = serializePattern(pattern, {}).replace(/\{.*\}/, (json) =>
    json.replaceAll('"', "&quot;"),
  );
  expect(deserializePattern(serialized)).toEqual(pattern);
});
