---
"ghost-postmark-email-adapter": minor
---

Add `PostmarkSuppressionProvider`, a standalone Ghost suppression-adapter implementation backed by Postmark's per-message-stream Suppressions API, mirroring `ghost-ses-email-adapter`'s `SESSuppressionProvider`. Supports `getSuppressionData(email)`, `getBulkSuppressionData(emails)` (bounded to 10 concurrent lookups, since Postmark has no single-address lookup endpoint and only a filterable dump list), and `removeEmail(email)`. Exported from the package entry point.
