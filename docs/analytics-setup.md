# Postmark analytics setup

`PostmarkAnalyticsProvider` polls Postmark's REST API directly — there is no webhook receiver or queue to stand up, unlike the SES adapter's SQS-based analytics provider. Everything it needs comes from the same Server API token used for sending.

## Ghost integration status

Ghost does not yet have separate wiring to load a third-party analytics adapter automatically (a different gap from the email-*sending* adapter wiring this package's patches work around). Until that exists, this provider polls correctly when instantiated directly, but Ghost's own analytics service will not discover or drive it on its own.

## Configuration

```js
const {PostmarkAnalyticsProvider} = require('ghost-postmark-email-adapter');

const analyticsProvider = new PostmarkAnalyticsProvider({
    serverToken: 'POSTMARK_SERVER_TOKEN',
    messageStream: 'broadcast'
});
```

`messageStream` should match the Broadcast stream configured for sending (see the main README's account setup section) — bounces, opens, and deliveries are filtered to that stream so unrelated transactional traffic on the same Server never leaks into newsletter analytics.

Call `fetchLatest(batchHandler, options)` to poll: `options.begin`/`options.end` bound the window (bounces and deliveries only — see limitation below), `options.maxEvents` caps how many events one call returns, and `options.events` restricts which types are fetched (`delivered`, `opened`, `failed`, `complained`, `unsubscribed`).

## Important limitations

**The opens endpoint (`GET /messages/outbound/opens`) has no date-range parameter and Postmark's API caps `count + offset` at 10,000 total records.** Unlike bounces and deliveries, open events cannot be windowed server-side — the provider filters client-side after fetching, and once total opens for the account exceed 10,000 in a poll, the ceiling is hit and the run stops with a debug log rather than erroring. Accounts with heavy open-tracking volume should poll more frequently (smaller windows, more often) to stay under this ceiling, or accept that some `opened` events may not surface. `delivered` and `failed`/`complained`/`unsubscribed` (bounces) do not have this constraint — both endpoints support proper `fromdate`/`todate` filtering.

**Per-message metadata lookups.** Matching an event back to Ghost's `emailId` requires an extra `GET /messages/outbound/{id}/details` call per distinct message (Postmark's bounce/opens/outbound-message list responses don't include the `email-id` metadata directly). The provider caches this per message within a single `fetchLatest()` call, so an open and a later delivery for the same message only trigger one lookup, not two — but a poll touching many distinct messages still makes one details call per message.

**Bounce classification.** Postmark's bounce feed carries more than delivery failures — administrative records like autoresponders, subscribe/unsubscribe requests, and graylisting challenges share the same "bounce" concept in Postmark's API. Only genuine delivery-failure types (`HardBounce`, `SoftBounce`, `Transient`, `DnsError`, `BadEmailAddress`, `Blocked`, `SMTPApiError`, `DMARCPolicy`, `TemplateRenderingFailed`, `Unknown`) are reported as Ghost's `failed`. `SpamComplaint` maps to `complained`, `Unsubscribe` maps to `unsubscribed`, and everything else is skipped rather than misreported as a failure.
