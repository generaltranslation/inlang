---
"@inlang/cli": patch
---

`inlang machine translate` no longer writes a translation that dropped or changed a variable or markup tag of the source, such as a translated `{count}` or a missing `<link>`, and doesn't create a new message that would have one. It reports them by locale with their bundle ids.
