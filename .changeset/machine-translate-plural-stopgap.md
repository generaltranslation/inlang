---
"@inlang/cli": patch
---

`inlang machine translate` no longer translates a message into a locale whose plurals need forms the source doesn't have, such as Russian `few` and `many` for an English `one` and `other`. Before, it copied the source's forms, and the translation used the wrong form for most numbers. The run reports these messages by locale; add the forms by hand, then run again.

It also warns when a locale's plural rules are unknown.
