---
"ghost-postmark-email-adapter": patch
---

Sync the Ghost 6.x wiring patch with `ghost-ses-email-adapter#55`'s fix for Ghost 6.54.0: `core/server/services/adapter-manager/index.js` switched from default imports/exports to named exports, requiring `require('../adapter-manager').default`. Also fixes the same `.default` requirement in this repo's own `test/integration/ghost-6.sh` verification snippet.
