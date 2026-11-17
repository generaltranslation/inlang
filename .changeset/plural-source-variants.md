---
"@inlang/sdk": patch
"@inlang/editor-component": patch
---

Add `sourceVariantFor`: the reference variant a form of a translation is translated from, the one the reference shows at runtime for the form's inputs (Russian `few` from English `*`).

Move `pluralExamples` from `@inlang/editor-component` (which still exports it) to `@inlang/sdk`.
