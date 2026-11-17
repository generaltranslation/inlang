---
"@inlang/cli": minor
---

General Translation is the default machine translation provider for `inlang machine translate`. Without a provider setting or a bring-your-own key, the command uses the General Translation key from `GT_API_KEY` (or `.env` / `.env.local` next to `project.inlang`). In an interactive terminal without a key, it offers to sign in to General Translation, which saves a development key to `.env.local`; answering No uses the free community translation service, as before. In CI and other non-interactive runs without a key, it fails right away and explains how to get one.

Bring-your-own keys keep working and still take precedence when set. `INLANG_MACHINE_TRANSLATE_PROVIDER=gt` selects General Translation explicitly. `INLANG_MACHINE_TRANSLATE_PROVIDER=demosjarco` still selects the community service.

A run with nothing to translate no longer needs a provider.
