---
"@inlang/sdk": minor
"@inlang/editor-component": patch
---

Add `sourceVariantFor`: the reference variant a form of a translation is translated from, the one the reference shows at runtime for the form's inputs. A plural category comes from the reference's category for the same numbers, not the one with the same name: Russian `few` from English `*`, and Russian `many` from French `*` rather than French `many` (millions).

`pluralRules` takes a form's matches to resolve a plural whose type is a variable (i18next's `type=$pluralType`), and gives each category's sample numbers (`sampleNumbers`).

Move `pluralExamples` from `@inlang/editor-component` (which still exports it) to `@inlang/sdk`.

`missing-variant` treats a plural category that selects only 0 as the exact 0 form: Arabic "zero" is `=0`, so Arabic i18next `_zero` no longer reports a missing `=0`, with ordinal forms too.

Expose `spelledOutInputs` so translation validation can share the SDK's exact-number and single-number plural exceptions.
