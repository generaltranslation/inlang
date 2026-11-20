---
"@inlang/cli": patch
---

`inlang machine translate` reports messages whose plurals need forms the source doesn't have in a target locale, such as Russian `few` and `many` for an English `one` and `other`. It still translates the source's forms, as before, including the catch-all next to an `other` unless the translation has every form its language needs: Russian `other` is only for fractions. The missing forms stay missing until they are added by hand; whether those numbers fall back to another form depends on the message format (i18next shows the message key). A translation whose selectors aren't the source's, in any order, such as a hand-written plural of a text or a text without the source's plural, is left as it is, and reported when it has an empty form, including a select value only it has, or lacks one its selectors need. A translation without forms gets the source's, with the source's selectors, like a new one: only with all its translations. The report lists the forms and message ids by locale, the first five and how many more. It is printed before anything is written, so a failed write keeps it, and leaves out a message that isn't created because one of its translations failed.

It also warns when a locale's plural rules are unknown.
