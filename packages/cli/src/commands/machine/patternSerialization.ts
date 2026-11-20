import { Text, VariableReference, type VariantRow } from "@inlang/sdk";

type PlaceholderMetadata = Record<
  string,
  {
    leadingCharacter?: string;
    trailingCharacter?: string;
  }
>;

const escapeStart = `<span class="notranslate">`;
const escapeEnd = "</span>";

export function findMatchingVariant<V extends Pick<VariantRow, "matches">>(
  variants: V[],
  matches: VariantRow["matches"],
): V | undefined {
  if (matches.length === 0) {
    return variants.find((variant) => variant.matches.length === 0);
  }

  return variants.find((variant) => {
    if (variant.matches.length !== matches.length) {
      return false;
    }

    return matches.every((sourceMatch) =>
      variant.matches.some((targetMatch) => {
        if (
          targetMatch.key !== sourceMatch.key ||
          targetMatch.type !== sourceMatch.type
        ) {
          return false;
        }

        if (
          sourceMatch.type === "literal-match" &&
          targetMatch.type === "literal-match"
        ) {
          return sourceMatch.value === targetMatch.value;
        }

        return true;
      }),
    );
  });
}

export function serializePattern(
  pattern: VariantRow["pattern"],
  placeholderMetadata: PlaceholderMetadata,
) {
  let result = "";
  for (const [index, element] of pattern.entries()) {
    if (element.type === "text") {
      result += escapeHtml(element.value)
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
      result += `${escapeStart}${escapeHtml(JSON.stringify(element))}${escapeEnd}`;
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
  const appendText = (value: string) =>
    result.push({
      type: "text",
      value: unescapeHtml(
        value
          .replaceAll("<inlang-CarriageReturn>", "\r")
          .replaceAll("<inlang-LineFeed> ", "\n")
          .replaceAll("<inlang-LineFeed>", "\n"),
      ),
    });
  let index = 0;
  while (index < text.length) {
    const start = text.indexOf(escapeStart, index);
    if (start === -1) {
      appendText(text.slice(index));
      break;
    } else if (index < start) {
      appendText(text.slice(index, start));
      index = start;
      continue;
    }
    const end = text.indexOf(escapeEnd, start);
    if (end === -1) {
      appendText(text.slice(index));
      break;
    }

    const expressionAsText = unescapeHtml(
      text.slice(start + escapeStart.length, end),
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

// Decode only after finding placeholder boundaries: a literal span in the
// source, or a closing span inside JSON, must never become a delimiter.
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function unescapeHtml(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}
