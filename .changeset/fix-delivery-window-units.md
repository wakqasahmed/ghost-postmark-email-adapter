---
"ghost-postmark-email-adapter": patch
---

Fix `getTargetDeliveryWindow()` returning `3600` (intended as an hour) when Ghost core interprets the value as milliseconds, corrupting Ghost's internal delivery-deadline calculation. Now returns `0`, which Ghost treats as "no deadline" and skips batch delivery-time spreading entirely — correct for this adapter, which sends immediately and cannot honor a delivery-time hint.
