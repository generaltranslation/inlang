---
"@inlang/sdk": patch
"@inlang/editor-component": patch
---

Add `sourceVariantFor`: the reference variant a form of a translation is translated from, the one the reference shows at runtime for the form's inputs (Russian `few` from English `*`).

`pluralRules` takes a form's matches to resolve a plural whose type is a variable (i18next's `type=$pluralType`).

Move `pluralExamples` from `@inlang/editor-component` (which still exports it) to `@inlang/sdk`.

`missing-variant` treats a plural category that selects only 0 as the exact 0 form: Arabic "zero" is `=0`, so Arabic i18next `_zero` no longer reports a missing `=0`, with ordinal forms too.
