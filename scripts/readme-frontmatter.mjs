// Keeps the inlang.com marketplace frontmatter out of the README on npm.
//
// The marketplace reads a package's README.md from the repository, frontmatter
// and all (see marketplace-manifest.json). npm doesn't parse frontmatter: it
// renders the `title:`, `description:` lines and the closing `---` as a heading
// at the top of the package page.
//
// `prepack`: node <this> strip — moves README.md aside and writes it without
// its frontmatter. `postpack`: node <this> restore — puts the original back.
// Run in the package's folder, as npm and pnpm run lifecycle scripts.

import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const README = "README.md";
const ORIGINAL = ".README.md.with-frontmatter";

/** `markdown` without a leading `---` frontmatter block and the blank lines after it. */
export function stripFrontmatter(markdown) {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n(?:\s*\r?\n)*/.exec(markdown);
  return match ? markdown.slice(match[0].length) : markdown;
}

/**
 * Puts the original README back, if one was moved aside. Only while README.md
 * is still the copy `strip` wrote: after an interrupted pack, README.md may
 * have been edited or come from another branch, and is kept then.
 */
export async function restore() {
  if (!existsSync(ORIGINAL)) return;
  const original = await readFile(ORIGINAL, "utf8");
  const current = existsSync(README) ? await readFile(README, "utf8") : undefined;
  if (current !== undefined && current !== stripFrontmatter(original)) {
    throw new Error(
      `${README} changed after a pack stopped before restoring it. ${ORIGINAL} holds the README from before that pack. Keep the README you want as ${README}, delete ${ORIGINAL}, then pack again.`,
    );
  }
  await rename(ORIGINAL, README);
}

/** Moves README.md aside and writes it without its frontmatter. */
export async function strip() {
  // A pack that stopped before `postpack` left the original aside.
  await restore();
  const markdown = await readFile(README, "utf8");
  const stripped = stripFrontmatter(markdown);
  if (stripped !== markdown) {
    await rename(README, ORIGINAL);
    await writeFile(README, stripped);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const mode = process.argv[2];
  try {
    if (mode === "strip") await strip();
    else if (mode === "restore") await restore();
    else throw new Error(`Unknown mode "${mode}". Use strip or restore.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
