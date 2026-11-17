---
"@inlang/cli": patch
---

`inlang machine translate` sends at most 4 requests at once and starts no more after a translation fails. It still saves the translations that came back, says how many, and exits with code 1; run it again to translate the rest. A message gets a language only when all its translations came back.
