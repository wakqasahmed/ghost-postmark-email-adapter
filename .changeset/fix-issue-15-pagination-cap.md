---
"ghost-postmark-email-adapter": patch
---

Apply Postmark's 10,000-record count+offset pagination ceiling to bounces and deliveries, not just opens (all three endpoints share the same API limit). Previously only opens was bounded; bounces/deliveries would hit a 422 error past that offset, silently stopping the poll without the explicit ceiling-reached log opens already had. Corrected docs/analytics-setup.md, which incorrectly claimed bounces/deliveries were unaffected.
