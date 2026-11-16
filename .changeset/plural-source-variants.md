---
"@inlang/sdk": minor
"@inlang/editor-component": patch
---

New `sourceVariantFor(target, referenceVariants, declarations, referenceLocale)`: the reference variant a form of a translation is translated from. Select values and exact numbers must match; a plural category the reference has no variant for in that branch comes from the branch's `other`, or else its catch-all (Russian `few` from English `*`, `few · female` from `* · female`). A select value falls back to the reference's catch-all only when its branch has no variant for the category, and variants the reference locale never selects (English `zero`) are skipped.

`pluralExamples(locale, type, { exclude, offset })` moved from `@inlang/editor-component` to `@inlang/sdk`, unchanged, so example numbers per plural category can be used outside the editor. `@inlang/editor-component` still exports it.
