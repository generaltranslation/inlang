---
"@inlang/cli": patch
---

`inlang check` now points to `machine translate` when a translation is missing or empty. The text output ends with one line, e.g. ``Translate what's missing with `npx @inlang/cli machine translate --project ./project.inlang`.`` JSON output and exit codes are unchanged.
