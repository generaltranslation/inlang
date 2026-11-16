---
"@inlang/cli": minor
---

`inlang machine translate` writes nothing unless every translation succeeded. Before, a run that failed partway kept the translations that had succeeded; now the first failed request stops the run, no file changes, and the command exits with code 1, so rerunning it starts from the same state.

The command also sends at most 4 requests at once instead of one per bundle at the same time, which keeps large projects within the providers' rate limits.
