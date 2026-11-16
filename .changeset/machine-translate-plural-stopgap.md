---
"@inlang/cli": minor
---

`inlang machine translate` no longer translates a message into a locale whose plurals need forms the source doesn't have, such as Russian `few` and `many` for an English `one` and `other`. Before, it copied the source's forms, and the translation used the wrong form for most numbers. The run reports these messages by locale; add the forms by hand, then run again.

The command also warns when a selector has plural categories as keys but isn't declared as a plural, and when the plural rules of a locale are unknown. A variant matching `other` now counts as the catch-all (`*`) and the other way around.
