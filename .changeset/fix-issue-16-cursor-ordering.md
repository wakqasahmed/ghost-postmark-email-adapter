---
"ghost-postmark-email-adapter": patch
---

Sort analytics events oldest-first before dispatching to batchHandler, instead of whatever order Postmark's paginated API returned them in. Ghost's analytics cursor advances to the newest timestamp in each processed batch; dispatching events in the API's (conventionally newest-first) order risked the cursor skipping past older, unprocessed events. Each event category now collects its fetched pages and sorts before dispatch, correct whenever maxEvents is unbounded or all pages are fetched (see docs/analytics-setup.md for the narrower residual case).
