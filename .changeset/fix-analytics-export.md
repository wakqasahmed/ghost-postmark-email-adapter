---
"ghost-postmark-email-adapter": patch
---

Fix `PostmarkAnalyticsProvider` never being exported from the package entry point, which made the documented `require('ghost-postmark-email-adapter').PostmarkAnalyticsProvider` throw for every user.
