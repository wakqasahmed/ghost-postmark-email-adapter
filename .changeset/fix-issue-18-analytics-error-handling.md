---
"ghost-postmark-email-adapter": patch
---

Fix inconsistent analytics error handling: list-fetch failures (bounces/opens/deliveries) were only logged via `debug()`, invisible without `DEBUG=email-analytics:postmark-adapter` set — a bad or revoked `serverToken` would make `fetchLatest()` resolve with zero events forever, silently. Meanwhile a single failed per-message details lookup (aged-out 404, mid-poll 429) had no error handling at all and aborted the *entire* poll, discarding already-collected events in the same category and skipping any event category not yet fetched that run. Both failure classes now follow the same skip-and-continue policy — one bad lookup or list page no longer aborts unrelated work — and both are logged at a level visible without `DEBUG`.
