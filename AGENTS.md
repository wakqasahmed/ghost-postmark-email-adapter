# ghost-postmark-email-adapter — Agent Context

## What this project is

A standalone npm package providing a **Postmark bulk email provider adapter for Ghost**, following the same community-adapter conventions as `ghost-ses-email-adapter` (same author, same layout). Installable via npm alias or copyable into `content/adapters/email/postmark/`, configured via Ghost's `adapters.email` config block.

## Template repository — reuse, do not re-derive

`ghost-ses-email-adapter` (https://github.com/wakqasahmed/ghost-ses-email-adapter) is the reference implementation for structure, contracts, error handling, retry/idempotency state, PII redaction, tests, patches, and CI. Mirror its conventions unless Postmark's API makes that impossible.

## Critical architectural facts (verified against Ghost source — do not re-derive)

1. Ghost's `AdapterManager` loads third-party adapters from `node_modules` and `content/adapters/`, but stock Ghost's `EmailServiceWrapper` hardcodes `MailgunEmailProvider`. Until upstream PR TryGhost/Ghost#29553 merges, this adapter needs the interim wiring patch in `patches/` (adapter-agnostic; shared with the SES adapter).
2. Email provider contract (from Ghost's `mailgun-email-provider.js`): `async send(data, options) -> {id}`, `getMaximumRecipients() -> number`, `getTargetDeliveryWindow() -> number`. `data` = `{subject, html, plaintext, from, replyTo, emailId, recipients: [{email, replacements}], replacementDefinitions: [{id, token}]}`. `options` = `{openTrackingEnabled, clickTrackingEnabled, deliveryTime}`.
3. Analytics provider contract (from Ghost's `email-analytics-provider-mailgun.js` and the SES adapter's `SESAnalyticsProvider`): `async fetchLatest(batchHandler, {begin, end, maxEvents, events})`; events passed to `batchHandler` as `[{id, type, severity?, error?, emailId, providerId, recipientEmail, timestamp}]` with `type` in `delivered|opened|failed|complained|unsubscribed`. Ghost tracks clicks itself via `/r/` redirects — click events from the provider are NOT mapped.
4. Personalization: Mailgun uses server-side `%recipient.x%` variables; Postmark has no equivalent for non-template sends. Render content per recipient adapter-side (see the SES adapter's `#processReplacements`, including HTML escaping of replacement values) and use Postmark's batch email API (`POST /email/batch`, max 500 messages/call, official `postmark` npm client `sendEmailBatch`).
5. Correlate Ghost's `emailId` with Postmark via the per-message `Metadata` field (echoed back by Postmark's messages/events APIs) — the equivalent of the SES adapter's `email-id` message tag.
6. Tracking flags map directly: `TrackOpens: options.openTrackingEnabled`, `TrackLinks: options.clickTrackingEnabled ? 'HtmlAndText' : 'None'` — no configuration-set gymnastics like SES.
7. Bulk sends must use a Broadcast message stream (`MessageStream` config, default name `broadcast`); Postmark rejects bulk mail on the transactional stream.
8. Analytics via polling (no webhook infrastructure): candidate endpoints are `GET /messages/outbound` (supports metadata + date filters), `GET /messages/outbound/opens`, and `GET /bounces` (bounces + `SpamComplaint` type). **Verify current Postmark API docs before implementing** — especially whether per-recipient `delivered` events are pollable; if not, document the limitation and emit only what polling supports.

## Version targets

- **Primary: Ghost 6.x** (`ghost:6-alpine`). Ghost 5.x is backlog.

## Testing conventions

- Unit tests: mocha/should/sinon (match Ghost core for upstream portability). Mock the `postmark` client — never hit the real API in tests.
- Integration: disposable `ghost:6-alpine` Docker container with the wiring patch + this package installed (copy the harness from the SES adapter's `test/integration/`). Never test against staging/production containers. Clean up containers after.

## Repo conventions

- No AI attribution in commits. Feature branches + PRs to `main`; never commit to `main` directly after the initial scaffold.
- Changesets for versioning/release (`.changeset/`).
- Reference issues in commit messages: `fix: batch chunking (#4)`.
