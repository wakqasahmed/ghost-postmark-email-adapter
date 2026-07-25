---
"ghost-postmark-email-adapter": patch
---

Fix fromdate/todate sent to Postmark's bounce and outbound-messages APIs: previously formatted as UTC ISO strings (date.toISOString(), Z-suffixed), but Postmark's docs specify these parameters as naive Eastern Time timestamps (format YYYY-MM-DDT12:00:00, no offset). Now converts using the IANA America/New_York zone (DST-aware). Without this, the server-side date window could have been shifted by 4-5 hours from what was requested.
