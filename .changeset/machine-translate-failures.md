---
"@inlang/cli": patch
---

`inlang machine translate` sends at most 4 requests at once and stops at the first failed translation. It still saves the translations that came back, says how many, and exits with code 1; run it again to translate the rest. A message gets a language only with all its translations, so a plural is never saved with some of its forms missing.
