---
"@inlang/cli": minor
---

General Translation is the default machine translation provider for `inlang machine translate`. Without a provider setting or a bring-your-own key, the command uses the General Translation key from `GT_API_KEY` (or `.env` / `.env.local` next to `project.inlang`). In an interactive terminal without a key, it asks whether to use General Translation for the project: Yes signs in, saves a development key to `.env.local` and the project ID to `gt.config.json`, so teammates use the same project. No uses the free community translation service, as before, and saves that choice to `.env.local`, so later runs don't ask again. In CI and other non-interactive runs without a provider setting or usable key, it keeps using the free community service and prints how to select a provider explicitly. This preserves existing keyless automation without prompting or saving a local preference.

Bring-your-own keys keep working and still take precedence when set. `INLANG_MACHINE_TRANSLATE_PROVIDER=gt` selects General Translation explicitly and still fails with setup instructions when a non-interactive run has no GT key. GT authentication, billing and service failures never fall back to another provider. `INLANG_MACHINE_TRANSLATE_PROVIDER=demosjarco` still selects the community service.

A run with nothing to translate no longer needs a provider.
