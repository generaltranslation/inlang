---
"@inlang/cli": patch
---

`inlang machine translate` no longer writes a translation that came back empty, or with a variable or markup tag of the source dropped, added or changed, or with markup that doesn't nest, such as a translated `{count}`, another `currency` option or a missing `</link>`, and doesn't create a new message that would have one. It saves the other translations, lists the rejected ones by locale with their bundle ids and why, and exits with 1.

An exact-number or single-number plural form may spell out its own count, including ICU `#` (such as Arabic duals). Other variables, currency and unit formatters, and markup must still be preserved; changed formatter options and added expressions are rejected.
