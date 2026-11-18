---
"@inlang/cli": patch
---

`inlang machine translate` reports messages whose plurals need forms the source doesn't have in a target locale, such as Russian `few` and `many` for an English `one` and `other`. It still translates the source's forms, as before. The missing forms stay missing until they are added by hand; whether those numbers fall back to another form depends on the message format (i18next shows the message key). A translation whose selectors aren't the source's, such as a hand-written plural of a text, is left as it is. The report lists the forms and message ids by locale.

It also warns when a locale's plural rules are unknown.
