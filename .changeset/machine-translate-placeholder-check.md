---
"@inlang/cli": minor
---

`inlang machine translate` no longer writes a translation that dropped or changed a variable or markup tag of the source, for example a translated `{count}` or a missing `<link>`. It checks each translation as `inlang check` does (which compares opening and standalone markup tags, not closing ones), leaves those variants missing as they were (and doesn't create a new message that would have one of them; the runtime then falls back to another locale), and reports them by locale with their bundle ids. The other translations are written and the command still exits with code 0. A form for a single number, such as German `one`, may still spell out its number.
