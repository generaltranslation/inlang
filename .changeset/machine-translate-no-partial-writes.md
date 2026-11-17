---
"@inlang/cli": patch
---

`inlang machine translate` no longer writes partial results: if a translation fails, no file changes and the command exits with code 1. It sends at most 4 requests at once.
