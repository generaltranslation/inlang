import {
  isPluralSelector,
  Text,
  VariableReference,
  type Declaration,
  type VariantRow,
} from "@inlang/sdk";

type PlaceholderMetadata = Record<
  string,
  {
    leadingCharacter?: string;
    trailingCharacter?: string;
  }
>;

const escapeStart = `<span class="notranslate">`;
const escapeEnd = "</span>";

/**
 * The variant with the same matches. On a plural selector, an explicit `other`
 * is the catch-all (see the SDK's `variantCovers`), so either one matches the
 * other, unless a source variant has that variant's own matches: a source with
 * both `other` and `*` keeps both.
 */
export function findMatchingVariant<V extends Pick<VariantRow, "matches">>({
  variants,
  matches,
  sourceVariants,
  declarations,
}: {
  variants: V[];
  matches: VariantRow["matches"];
  sourceVariants: VariantRow[];
  declarations: Declaration[] | undefined;
}): V | undefined {
  const valueOf = (list: VariantRow["matches"], key: string) => {
    const match = list.find((value) => value.key === key);
    return match && (match.type === "literal-match" ? match.value : "*");
  };
  const isOtherOrCatchAll = (value: string | undefined) =>
    value === "other" || value === "*";
  const same = (
    a: VariantRow["matches"],
    b: VariantRow["matches"],
    otherIsCatchAll: boolean,
  ) =>
    a.length === b.length &&
    b.every((match) => {
      const [value, expected] = [valueOf(a, match.key), valueOf(b, match.key)];
      return (
        value === expected ||
        (otherIsCatchAll &&
          isOtherOrCatchAll(value) &&
          isOtherOrCatchAll(expected) &&
          isPluralSelector(match.key, declarations))
      );
    });
  return (
    variants.find((variant) => same(variant.matches, matches, false)) ??
    variants.find(
      (variant) =>
        same(variant.matches, matches, true) &&
        !sourceVariants.some((source) =>
          same(source.matches, variant.matches, false),
        ),
    )
  );
}

export function serializePattern(
  pattern: VariantRow["pattern"],
  placeholderMetadata: PlaceholderMetadata,
) {
  let result = "";
  for (const [index, element] of pattern.entries()) {
    if (element.type === "text") {
      result += element.value
        .replaceAll("\r", "<inlang-CarriageReturn>")
        .replaceAll("\n", "<inlang-LineFeed>");
    } else {
      // @ts-expect-error placeholder metadata is keyed by name at runtime
      placeholderMetadata[element.name] = {
        leadingCharacter: result.at(-1) ?? undefined,
        trailingCharacter:
          pattern[index + 1]?.type === "text"
            ? (pattern[index + 1] as Text).value[0]
            : undefined,
      };
      result += `${escapeStart}${JSON.stringify(element)}${escapeEnd}`;
    }
  }
  return result;
}

/** An expression with an argument, or markup with a name. */
function isPlaceholder(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const { type, arg, name } = value as Record<string, unknown>;
  return type === "expression"
    ? typeof arg === "object" && arg !== null
    : typeof type === "string" &&
        type.startsWith("markup-") &&
        typeof name === "string";
}

export function deserializePattern(text: string): VariantRow["pattern"] {
  const result: VariantRow["pattern"] = [];
  const unescapedText = text
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("<inlang-CarriageReturn>", "\r")
    .replaceAll("<inlang-LineFeed> ", "\n")
    .replaceAll("<inlang-LineFeed>", "\n");
  let index = 0;
  while (index < unescapedText.length) {
    const start = unescapedText.indexOf(escapeStart, index);
    if (start === -1) {
      result.push({ type: "text", value: unescapedText.slice(index) });
      break;
    } else if (index < start) {
      result.push({ type: "text", value: unescapedText.slice(index, start) });
      index = start;
      continue;
    }
    const end = unescapedText.indexOf(escapeEnd, start);
    if (end === -1) {
      result.push({ type: "text", value: unescapedText.slice(index) });
      break;
    }

    const expressionAsText = unescapedText.slice(
      start + escapeStart.length,
      end,
    );
    const expression = JSON.parse(expressionAsText) as VariableReference;
    // The provider can return any JSON here, which later checks would trip on.
    if (!isPlaceholder(expression)) {
      throw new SyntaxError(`Not a placeholder: ${expressionAsText}`);
    }

    // @ts-expect-error placeholder metadata is preserved at runtime
    result.push(expression);
    index = end + escapeEnd.length;
  }
  return result;
}
