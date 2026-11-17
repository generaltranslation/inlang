---
"@inlang/sdk": patch
"@inlang/editor-component": patch
---

Add `sourceVariantFor`: the reference variant a form of a translation is translated from, the one the reference shows at runtime for the form's inputs (Russian `few` from English `*`).

`pluralRules` takes a form's matches to resolve a plural whose type is a variable (i18next's `type=$pluralType`).

Move `pluralExamples` from `@inlang/editor-component` (which still exports it) to `@inlang/sdk`.

`missing-variant` treats an exact number and the plural category that selects only that number as one form. Arabic "zero" (only 0) is `=0`, so Arabic i18next `_zero` no longer reports a missing `=0`. A category that is never shown, because an exact number wins, is no longer required.
