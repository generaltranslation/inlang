---
"@inlang/cli": patch
---

`inlang machine translate` writes the translation files as soon as each target locale is done, one locale at a time, while the requests of all locales still share the provider's request slots. A run that is stopped, times out in CI or hits a provider failure keeps every locale it finished, so the next run doesn't translate and pay for them again. A provider failure or Ctrl+C sends no further requests and saves the translations that came back, from requests already in flight too; a second Ctrl+C quits without saving them. A failed text doesn't stop the other locales.
