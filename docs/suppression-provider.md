# Suppression provider

Issue [#25](https://github.com/wakqasahmed/ghost-postmark-email-adapter/issues/25) added a standalone `PostmarkSuppressionProvider`. It uses Postmark's per-message-stream [Suppressions API](https://postmarkapp.com/developer/api/suppressions-api) and follows Ghost's proposed suppression-adapter contract:

```js
const {PostmarkSuppressionProvider} = require('ghost-postmark-email-adapter');

const suppressionProvider = new PostmarkSuppressionProvider({
    serverToken: 'POSTMARK_SERVER_TOKEN',
    messageStream: 'broadcast'
});
```

It supports `getSuppressionData(email)`, `getBulkSuppressionData(emails)`, and `removeEmail(email)`. `messageStream` should match the Broadcast stream configured for sending (see the main README's account setup section) — suppressions are per-stream in Postmark, so this must line up with `PostmarkEmailProvider`'s `messageStream` or lookups will miss entries recorded against a different stream. It defaults to `'broadcast'` when omitted, matching the other providers in this package.

## How lookups work

Unlike SES's SESv2, Postmark has no "get a single address's suppression status" endpoint. The only read endpoint is `GET /message-streams/{stream}/suppressions/dump`, a filterable list. `getSuppressionData(email)` calls it with an `emailAddress` filter and treats an empty result as unsuppressed — there's no separate "not found" error case to catch, since the dump endpoint returns 200 with an empty array rather than erroring.

`getBulkSuppressionData(emails)` calls `getSuppressionData` for every address but bounds concurrency to 10 lookups in flight at a time, the same bound the SES sibling adapter uses for its `GetSuppressedDestination` calls. Ghost calls this for every members-list page, potentially hundreds of emails at once; an unbounded `Promise.all` across a whole page would fire that many concurrent dump requests at once.

## Reason mapping

Postmark's `SuppressionReason` enum has exactly three documented values: `HardBounce`, `SpamComplaint`, and `ManualSuppression`. Only `SpamComplaint` is a spam signal — `HardBounce` and an operator-issued `ManualSuppression` are both non-spam delivery blocks — so `SpamComplaint` maps to Ghost's `spam` and both other reasons map to `fail`.

## Timestamp handling

Ghost's suppression-list service asserts `info.timestamp` is a `Date` whenever a suppression is reported. Postmark's dump response returns `CreatedAt` as an ISO 8601 string; this provider always parses it into a real `Date`, and falls back to the current time if `CreatedAt` is missing or unparseable, so a suppressed result never carries an `undefined` or invalid timestamp.

## Removal semantics

`removeEmail(email)` calls `POST /message-streams/{stream}/suppressions/delete`. Postmark's documented response `Status` for that call is either `Deleted` (success) or `Failed` (with a `Message` explaining why — for example, **`SpamComplaint` suppressions cannot be deleted** via this endpoint at all). `removeEmail` returns `true` only for `Deleted`; a `Failed` status, a missing entry in the response, or a request-level error (network, auth) all resolve to `false` rather than throwing, so a caller working through a members list doesn't have one unremovable address abort the run. A `HardBounce` removal is equivalent to reactivating the underlying bounce record in Postmark, per their docs.

**Error handling on lookup is fail-closed, not fail-open**, matching the SES sibling: a `getSuppressionData`/`getBulkSuppressionData` failure other than "no matching suppression" (throttling, network error, auth issue) is rethrown rather than reported as `{suppressed: false}` — treating an unknown suppression status as "clear" risks re-sending to an address Postmark has already suppressed. `removeEmail` is deliberately the exception (fail-closed in the opposite direction): any failure there just means the address stays suppressed, which is the safe outcome for a removal request that didn't clearly succeed.
