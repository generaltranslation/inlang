---
"@inlang/cli": patch
---

`inlang machine translate` translates one target locale at a time and writes the translation files when each locale is done. A run that is stopped, times out in CI or hits a provider failure keeps every locale it finished, so the next run doesn't translate and pay for them again. A provider failure stops the run after saving its locale; a failed text doesn't stop the later locales.
