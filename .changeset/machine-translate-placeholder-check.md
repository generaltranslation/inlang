---
"@inlang/cli": minor
---

`inlang machine translate` no longer writes a translation that dropped or changed a variable or markup of the source, for example a translated `{count}` or a missing `<link>`. It checks each translation as `inlang check` does, leaves those variants missing as they were (a new message is created only when none of its translations is left out), and reports them by locale with their bundle ids. The other translations are written and the command still exits with code 0. A form for a single number, such as German `one`, may still spell out its number.
