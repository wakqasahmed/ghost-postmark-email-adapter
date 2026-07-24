# ghost-postmark-email-adapter

[Postmark](https://postmarkapp.com) bulk email provider adapter for [Ghost](https://ghost.org), packaged as a standalone npm module following Ghost's community adapter conventions — a sibling of [ghost-ses-email-adapter](https://github.com/wakqasahmed/ghost-ses-email-adapter).

> **Status: pre-alpha — under active development.** See the [issues](https://github.com/wakqasahmed/ghost-postmark-email-adapter/issues) for the roadmap.

## Why

Ghost's native newsletter bulk-sending only integrates with Mailgun. Ghost core prefers a pluggable adapter mechanism with providers maintained by the community (see [TryGhost/Ghost#29553](https://github.com/TryGhost/Ghost/pull/29553)). This package is the community-maintained Postmark provider.

Until the upstream wiring PR lands, self-hosted installs need the interim wiring patch bundled in `patches/` (shared with the SES adapter — the patch is adapter-agnostic).

## Supported Ghost versions

| Ghost version | Status | Verified runtime | Interim wiring patch | Disposable check |
| --- | --- | --- | --- | --- |
| 6.x | Supported | `ghost:6-alpine` | [`ghost-6.x-email-adapter-wiring.patch`](patches/ghost-6.x-email-adapter-wiring.patch) | `test/integration/ghost-6.sh` |

Ghost 5.x is not currently supported by this package (backlog). Re-run the disposable check before every Ghost upgrade — the wiring patch tracks Ghost core's internals and can drift when Ghost updates (see [ghost-ses-email-adapter#55](https://github.com/wakqasahmed/ghost-ses-email-adapter/issues/55) for a live example of this happening).

## Before you start: Postmark account setup

1. **Server API token.** Create (or use an existing) Postmark Server, then copy its token from the Server's **API Tokens** tab. This is the `serverToken` config value — it authenticates as `X-Postmark-Server-Token` and has send access to every message stream on that Server.
2. **A Broadcast message stream.** Every new Server ships with a default Transactional stream (id `outbound`), but newsletters are bulk mail and must not share it — Postmark runs Broadcast streams on separate sending infrastructure to protect transactional deliverability. Create one from the Server's **Message Streams** tab (or the [Message Streams API](https://postmarkapp.com/developer/api/message-streams-api)) and use its ID as the `messageStream` config value (this adapter defaults to `broadcast` if you name it that).
3. **A verified sender.** Postmark refuses to send until the `fromEmail` address is verified — either a single **Sender Signature** (verify one address by clicking a confirmation link Postmark emails you), or **Domain Verification** (verify an entire sending domain, which requires adding a DKIM record to its DNS and is the better choice if Ghost sends from more than one address on the domain, e.g. newsletter plus staff notifications).

## Install on Ghost 6.x

This interim setup uses the bundled wiring patch because stock Ghost does not yet resolve third-party email adapters.

1. Apply [`patches/ghost-6.x-email-adapter-wiring.patch`](patches/ghost-6.x-email-adapter-wiring.patch) from the running Ghost runtime directory (`/var/lib/ghost/current` in the official image):

   ```bash
   cd /var/lib/ghost/current
   git apply /path/to/ghost-6.x-email-adapter-wiring.patch
   ```

2. Install the adapter using one discovery method. The npm package alias is recommended for deployments; use the content-adapter method only when you intentionally manage adapter files under `content/adapters/`.

   **Recommended: npm package alias** — run this from the Ghost installation root (the directory containing `current/`). The alias makes the package resolvable as the configured `postmark` adapter:

   ```bash
   cd current
   npm install --omit=dev --no-save postmark@npm:ghost-postmark-email-adapter
   ```

   **Content adapter** — extract the package at exactly `content/adapters/email/postmark/` under the Ghost installation root:

   ```bash
   mkdir -p content/adapters/email/postmark
   npm pack ghost-postmark-email-adapter
   tar -xzf ghost-postmark-email-adapter-*.tgz --strip-components=1 -C content/adapters/email/postmark
   npm install --omit=dev --prefix content/adapters/email/postmark
   ```

3. Add this block to `config.production.json`, replacing the example values. `active` must be `postmark`.

   ```json
   {
     "adapters": {
       "email": {
         "active": "postmark",
         "postmark": {
           "serverToken": "POSTMARK_SERVER_TOKEN",
           "fromEmail": "news@example.com",
           "messageStream": "broadcast"
         }
       }
     }
   }
   ```

   Never commit a real server token to Ghost configuration; prefer environment-variable substitution where available. `messageStream` must name a **Broadcast** stream (see [account setup](#before-you-start-postmark-account-setup)) — sending bulk mail through the default Transactional stream is against Postmark's terms and risks that stream's deliverability.

   Ghost retries a failed provider `send()` call for the entire provider batch, so this adapter advertises 500 recipients per batch (Postmark's `sendEmailBatch` limit) and retries only the recipients that actually failed within a batch, not the whole batch. It coalesces concurrent identical sends and identifies retries by Ghost's `emailId`, a caller-provided `idempotencyKey`, or an identical send payload. Retry state is capped at 1,000 keys (oldest first) to bound memory and in-process recipient-data retention — this protection is not durable across process restarts.

4. Restart Ghost after applying the patch, installing the adapter, and updating configuration.

### Docker

Build a derived image so the patch and adapter are present on every container start. The following Dockerfile assumes this repository is the build context:

```dockerfile
FROM ghost:6-alpine

USER root
RUN apk add --no-cache git
COPY patches/ghost-6.x-email-adapter-wiring.patch /tmp/ghost-email-adapter.patch
RUN cd /var/lib/ghost/current \
    && git apply /tmp/ghost-email-adapter.patch \
    && npm install --omit=dev --no-save postmark@npm:ghost-postmark-email-adapter
USER node
```

Pass the Postmark server token to the container through its secret manager or environment, and mount/provide the same `adapters.email` configuration shown above. Do not bake credentials into the image or Dockerfile.

### Disposable integration check

With Docker installed, run:

```bash
test/integration/ghost-6.sh
```

It builds a throwaway `postmark-adapter-test-*` image using a local `npm pack` archive, starts Ghost with SQLite and a fake Postmark server token, waits for Ghost to boot, then verifies the adapter is resolved by AdapterManager and that a real `adapter.send()` call reaches a local Postmark API stub with the expected payload (message stream, tracking flags, `email-id` metadata). It never sends through the real Postmark API. Failure output distinguishes patch-apply failures from adapter-resolution failures from send-payload mismatches (`FAILURE_STAGE=...`). Like the SES adapter, it deliberately uses the floating `ghost:6-alpine` image so each run tests the Ghost 6.x release Docker Hub serves at that time — run it before applying the patch to a Ghost update.

### Non-Docker

For a normal Ghost installation, apply the patch from its active runtime directory (the directory equivalent to `/var/lib/ghost/current`), then install the npm alias there, update `config.production.json`, and restart through its normal service manager. Use the content-adapter path only when you intentionally manage adapters under `content/adapters/`.

## Analytics

`PostmarkAnalyticsProvider` polls Postmark's REST API for opens, bounces, and complaints — no webhook infrastructure required, unlike the SES adapter's SQS-based provider. Ghost does not yet have the separate analytics-adapter wiring required to load it automatically (same gap the send provider's wiring patch works around), so this is not yet a plug-and-play Ghost feature; see [docs/analytics-setup.md](docs/analytics-setup.md) for the Postmark-side setup and its **polling limitations** — most notably, the opens endpoint has no server-side date filter and is hard-capped at 10,000 records per poll, which accounts with heavy open-tracking volume will hit.

```js
const {PostmarkAnalyticsProvider} = require('ghost-postmark-email-adapter');

const analyticsProvider = new PostmarkAnalyticsProvider({
    serverToken: 'POSTMARK_SERVER_TOKEN',
    messageStream: 'broadcast'
});
```

Event types: `delivered`, `opened`, `failed` (with `severity: 'temporary'|'permanent'`), `complained`, and `unsubscribed` (Postmark's `Unsubscribe` bounce type — a genuine recipient action, not a delivery failure). Only bounce types that represent an actual delivery failure are reported as `failed`; Postmark's bounce feed also carries administrative records (autoresponders, subscribe requests, graylisting challenges, and similar) that are correctly skipped rather than misreported.

## Documentation

- [Analytics setup](docs/analytics-setup.md) — Postmark-side setup for the polling analytics provider, including its API limitations
- [Changelog](CHANGELOG.md) — release history

## Credits

This package follows the structure and conventions established by [ghost-ses-email-adapter](https://github.com/wakqasahmed/ghost-ses-email-adapter), the sibling SES adapter for Ghost.

## License

MIT
