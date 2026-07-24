# ghost-postmark-email-adapter

[Postmark](https://postmarkapp.com) bulk email provider adapter for [Ghost](https://ghost.org), packaged as a standalone npm module following Ghost's community adapter conventions — a sibling of [ghost-ses-email-adapter](https://github.com/wakqasahmed/ghost-ses-email-adapter).

> **Status: pre-alpha — under active development.** See the [issues](https://github.com/wakqasahmed/ghost-postmark-email-adapter/issues) for the roadmap.

## Why

Ghost's native newsletter bulk-sending only integrates with Mailgun. Ghost core prefers a pluggable adapter mechanism with providers maintained by the community (see [TryGhost/Ghost#29553](https://github.com/TryGhost/Ghost/pull/29553)). This package is the community-maintained Postmark provider.

Until the upstream wiring PR lands, self-hosted installs need the interim wiring patch bundled in `patches/` (shared with the SES adapter — the patch is adapter-agnostic).

## Planned configuration

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

Never commit real credentials to Ghost configuration; prefer environment-variable substitution where available.

## Disposable integration check

With Docker installed, run:

```bash
test/integration/ghost-6.sh
```

It builds a throwaway `postmark-adapter-test-*` image using a local `npm pack` archive, starts Ghost with SQLite and a fake Postmark server token, waits for Ghost to boot, then verifies the adapter is resolved by AdapterManager and that a real `adapter.send()` call reaches a local Postmark API stub with the expected payload (message stream, tracking flags, `email-id` metadata). It never sends through the real Postmark API. Failure output distinguishes patch-apply failures from adapter-resolution failures from send-payload mismatches (`FAILURE_STAGE=...`). Like the SES adapter, it deliberately uses the floating `ghost:6-alpine` image so each run tests the Ghost 6.x release Docker Hub serves at that time — run it before applying the patch to a Ghost update.

## License

MIT
