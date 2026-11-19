---
"@inlang/cli": patch
---

`inlang machine translate` sends at most 4 requests at once and keeps translating unrelated messages when an individual text fails. A rate-limited request (429) is sent again up to 3 times, after the provider's `Retry-After` or 2, 4 and 8 seconds, waiting at most a minute in total; other failures aren't retried. Authentication, billing, and service failures, and rate limits that outlast the retries, stop new requests. It still saves the translations that came back, says how many, and exits with code 1; run it again to translate the rest. A new message gets a language only when all its translations came back; a message that exists keeps those that did.
