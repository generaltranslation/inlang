---
"@inlang/cli": patch
---

Signing in to General Translation from `inlang machine translate` now says what it is waiting for while it loads your organizations and creates the project and key. The browser sign-in also explains what to do when the browser runs on another machine, such as with a remote container: run `npx gt login --no-browser`, which signs in with a code instead, then run again.
