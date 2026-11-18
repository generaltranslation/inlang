---
"@inlang/cli": patch
---

`inlang machine translate` reports messages whose plurals need forms the source doesn't have in a target locale, such as Russian `few` and `many` for an English `one` and `other`. It still translates the source's forms, as before, so the target's catch-all shows for those numbers until the missing forms are added by hand. The report lists the forms and message ids by locale.

It also warns when a locale's plural rules are unknown.
