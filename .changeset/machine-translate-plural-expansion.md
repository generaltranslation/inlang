---
"@inlang/cli": minor
---

`inlang machine translate` now translates every plural form a locale needs when the provider uses context (Russian `one`, `few`, `many` and `*` for an English `one` and `*`). Each form's context names its input, the form and the numbers it is used for, even when source and target category names match. Exact-number forms retain their exact meaning. Forms a translation already has are kept. With a provider without context, or when a translation's selectors differ from the source's or it has a select value the source doesn't (whose forms couldn't be translated, and would lose numbers to the forms added), such messages get the source's forms, as before, and are reported.
