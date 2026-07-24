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

## License

MIT
