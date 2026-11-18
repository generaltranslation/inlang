---
"@inlang/cli": minor
---

`inlang machine translate` now translates every plural form a locale needs when the provider uses context (Russian `one`, `few`, `many` and `*` for an English `one` and `*`). Each form's context names its input, the form and the numbers it is used for, even when source and target category names match. Exact-number forms retain their exact meaning. Forms a translation already has are kept. With a provider without context, or when a translation's selectors differ from the source's, such messages are still skipped and reported.
