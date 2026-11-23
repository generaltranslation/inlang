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

const README = "README.md";
const ORIGINAL = ".README.md.with-frontmatter";

/** `markdown` without a leading `---` frontmatter block and the blank lines after it. */
export function stripFrontmatter(markdown) {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n(?:\s*\r?\n)*/.exec(markdown);
  return match ? markdown.slice(match[0].length) : markdown;
}

const mode = process.argv[2];
if (mode === "strip") {
  // A run that stopped before `postpack` left the original aside: keep it.
  if (existsSync(ORIGINAL)) await rename(ORIGINAL, README);
  const markdown = await readFile(README, "utf8");
  const stripped = stripFrontmatter(markdown);
  if (stripped !== markdown) {
    await rename(README, ORIGINAL);
    await writeFile(README, stripped);
  }
} else if (mode === "restore") {
  if (existsSync(ORIGINAL)) await rename(ORIGINAL, README);
} else if (mode !== undefined) {
  console.error(`Unknown mode "${mode}". Use strip or restore.`);
  process.exit(1);
}
