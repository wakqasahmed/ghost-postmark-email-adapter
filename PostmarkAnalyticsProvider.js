'use strict';

const errors = require('@tryghost/errors');
const debug = require('@tryghost/debug')('email-analytics:postmark-adapter');

const PAGE_SIZE = 500;
const EMAIL_ADDRESS_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// Postmark's Bounce API, Messages API, and opens endpoint all cap count+offset at
// 10,000 total records (verified against postmarkapp.com/developer docs for each).
// Opens additionally has no fromdate/todate parameter, so it can't be windowed
// server-side at all - only bounded and filtered client-side (#isWithinWindow).
const MAX_PAGINATION_OFFSET = 10000;
// Only these bounce Types represent a message that failed to reach the recipient.
// Postmark's bounce feed also returns administrative/non-failure records for the
// same "bounce" concept - Subscribe, AutoResponder (an auto-reply to a delivered
// message), AddressChange, SpamNotification ("message was delivered, but..."),
// OpenRelayTest (a probe against the server, no real recipient), VirusNotification,
// ChallengeVerification (graylisting, not a final outcome), ManuallyDeactivated,
// Unconfirmed (double opt-in status), and InboundError (inbound routing, unrelated
// to an outbound recipient) - none of those are delivery failures.
const FAILURE_BOUNCE_TYPES = new Set([
    'HardBounce', 'SoftBounce', 'Transient', 'DnsError', 'BadEmailAddress',
    'Blocked', 'SMTPApiError', 'DMARCPolicy', 'TemplateRenderingFailed', 'Unknown'
]);
const TEMPORARY_BOUNCE_TYPES = new Set(['Transient', 'SoftBounce', 'DnsError']);

class PostmarkAnalyticsProvider {
    #client;
    #config;
    #postmark;

    constructor(config = {}) {
        const postmarkConfig = config.postmark || config;

        if (!postmarkConfig.serverToken) {
            throw new errors.IncorrectUsageError({
                message: 'Postmark analytics adapter requires serverToken in configuration'
            });
        }

        this.#postmark = require('postmark');
        this.#config = postmarkConfig;
        this.#client = new this.#postmark.ServerClient(postmarkConfig.serverToken);

        Object.defineProperty(this, 'requiredFns', {
            value: ['fetchLatest'],
            writable: false
        });
    }

    async fetchLatest(batchHandler, options = {}) {
        const maxEvents = options.maxEvents ?? Infinity;
        const requestedEvents = options.events || [];
        const shouldFetch = type => requestedEvents.length === 0 || requestedEvents.includes(type);
        const state = {eventCount: 0, maxEvents, detailsCache: new Map()};

        if (shouldFetch('failed') || shouldFetch('complained') || shouldFetch('unsubscribed')) {
            await this.#fetchBounces(batchHandler, options, state, shouldFetch);
        }

        if (state.eventCount < maxEvents && shouldFetch('opened')) {
            await this.#fetchOpens(batchHandler, options, state);
        }

        if (state.eventCount < maxEvents && shouldFetch('delivered')) {
            await this.#fetchDeliveries(batchHandler, options, state);
        }
    }

    async #fetchBounces(batchHandler, options, state, shouldFetch) {
        let offset = 0;

        while (state.eventCount < state.maxEvents && offset < MAX_PAGINATION_OFFSET) {
            const pageSize = Math.min(this.#remainingPageSize(state), MAX_PAGINATION_OFFSET - offset);
            let response;

            try {
                response = await this.#client.getBounces(new this.#postmark.BounceFilteringParameters(
                    pageSize, offset, undefined, undefined, undefined, undefined, undefined,
                    this.#formatDate(options.begin), this.#formatDate(options.end), this.#messageStream
                ));
            } catch (err) {
                debug(`Error fetching bounces at offset ${offset}: ${err.message}`);
                return;
            }
            const bounces = response?.Bounces || [];

            if (bounces.length === 0) {
                return;
            }

            const events = [];
            for (const bounce of bounces) {
                const event = await this.#mapBounce(bounce, options, state);
                if (event && shouldFetch(event.type)) {
                    events.push(event);
                }
            }

            await this.#handlePage(batchHandler, events, state);
            offset += bounces.length;
        }

        if (offset >= MAX_PAGINATION_OFFSET) {
            debug('Reached Postmark\'s 10,000-record bounce pagination ceiling (count+offset); some bounce events may not have been polled this run');
        }
    }

    async #fetchOpens(batchHandler, options, state) {
        let offset = 0;

        while (state.eventCount < state.maxEvents && offset < MAX_PAGINATION_OFFSET) {
            const pageSize = Math.min(this.#remainingPageSize(state), MAX_PAGINATION_OFFSET - offset);
            let response;

            try {
                response = await this.#client.getMessageOpens(new this.#postmark.OutboundMessageOpensFilteringParameters(
                    pageSize, offset, undefined, undefined, undefined, undefined, undefined,
                    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
                    this.#messageStream
                ));
            } catch (err) {
                debug(`Error fetching opens at offset ${offset}: ${err.message}`);
                return;
            }
            const opens = response?.Opens || [];

            if (opens.length === 0) {
                return;
            }

            const events = [];
            for (const open of opens) {
                const event = await this.#mapEvent(open, 'opened', options, state);
                if (event) {
                    events.push(event);
                }
            }

            await this.#handlePage(batchHandler, events, state);
            offset += opens.length;
        }

        if (offset >= MAX_PAGINATION_OFFSET) {
            debug('Reached Postmark\'s 10,000-record opens pagination ceiling (count+offset); some open events may not have been polled this run');
        }
    }

    async #fetchDeliveries(batchHandler, options, state) {
        let offset = 0;

        while (state.eventCount < state.maxEvents && offset < MAX_PAGINATION_OFFSET) {
            const pageSize = Math.min(this.#remainingPageSize(state), MAX_PAGINATION_OFFSET - offset);
            let response;

            try {
                response = await this.#client.getOutboundMessages(new this.#postmark.OutboundMessagesFilteringParameters(
                    pageSize, offset, undefined, undefined, undefined, undefined,
                    this.#formatDate(options.begin), this.#formatDate(options.end), undefined,
                    this.#messageStream
                ));
            } catch (err) {
                debug(`Error fetching deliveries at offset ${offset}: ${err.message}`);
                return;
            }
            const messages = response?.Messages || [];

            if (messages.length === 0) {
                return;
            }

            const events = [];
            for (const message of messages) {
                const emailId = message?.Metadata?.['email-id'];
                const providerId = message?.MessageID;

                if (!emailId || !providerId) {
                    debug(`Skipping Postmark delivery without email-id metadata or message ID`);
                    continue;
                }

                const details = await this.#getMessageDetails(providerId, state);
                for (const delivery of details?.MessageEvents || []) {
                    if (delivery.Type !== 'Delivered') {
                        continue;
                    }

                    const event = this.#createEvent({
                        id: `${providerId}:delivered:${delivery.Recipient}:${delivery.ReceivedAt}`,
                        type: 'delivered',
                        emailId,
                        providerId,
                        recipientEmail: delivery.Recipient,
                        timestamp: delivery.ReceivedAt
                    });

                    if (event && this.#isWithinWindow(event.timestamp, options)) {
                        events.push(event);
                    }
                }
            }

            await this.#handlePage(batchHandler, events, state);
            offset += messages.length;
        }

        if (offset >= MAX_PAGINATION_OFFSET) {
            debug('Reached Postmark\'s 10,000-record outbound-messages pagination ceiling (count+offset); some delivered events may not have been polled this run');
        }
    }

    async #mapBounce(bounce, options, state) {
        if (bounce?.Type === 'SpamComplaint') {
            const event = await this.#mapEvent(bounce, 'complained', options, state);
            if (event) {
                event.id = `bounce:${bounce.ID}`;
            }
            return event;
        }

        if (bounce?.Type === 'Unsubscribe') {
            const event = await this.#mapEvent(bounce, 'unsubscribed', options, state);
            if (event) {
                event.id = `bounce:${bounce.ID}`;
            }
            return event;
        }

        if (!FAILURE_BOUNCE_TYPES.has(bounce?.Type)) {
            debug(`Skipping non-failure Postmark bounce type ${bounce?.Type}`);
            return null;
        }

        const event = await this.#mapEvent(bounce, 'failed', options, state);
        if (!event) {
            return null;
        }

        event.severity = TEMPORARY_BOUNCE_TYPES.has(bounce.Type) ? 'temporary' : 'permanent';
        event.error = {
            code: String(bounce.TypeCode || bounce.Type || 'Bounce'),
            message: this.#redact(bounce.Details || bounce.Description || `Postmark ${bounce.Type || 'Unknown'} bounce`)
        };
        event.id = `bounce:${bounce.ID}`;
        return event;
    }

    async #mapEvent(record, type, options = {}, state) {
        const providerId = record?.MessageID;
        const recipientEmail = record?.Recipient || record?.Email;
        const timestamp = record?.ReceivedAt || record?.BouncedAt;

        if (!providerId || !recipientEmail || !timestamp) {
            debug(`Skipping malformed Postmark ${type} event`);
            return null;
        }

        const details = await this.#getMessageDetails(providerId, state);
        const emailId = details?.Metadata?.['email-id'];

        if (!emailId) {
            debug(`Skipping Postmark ${type} event ${providerId} without email-id metadata`);
            return null;
        }

        const event = this.#createEvent({
            id: `${providerId}:${type}:${timestamp}`,
            type,
            emailId,
            providerId,
            recipientEmail,
            timestamp
        });

        return event && this.#isWithinWindow(event.timestamp, options) ? event : null;
    }

    async #getMessageDetails(providerId, state) {
        if (state.detailsCache.has(providerId)) {
            return state.detailsCache.get(providerId);
        }

        const details = await this.#client.getOutboundMessageDetails(providerId);
        state.detailsCache.set(providerId, details);
        return details;
    }

    #createEvent(event) {
        const timestamp = new Date(event.timestamp);

        if (Number.isNaN(timestamp.getTime())) {
            debug(`Skipping malformed Postmark ${event.type} event`);
            return null;
        }

        return {...event, timestamp};
    }

    async #handlePage(batchHandler, events, state) {
        const page = events.slice(0, state.maxEvents - state.eventCount);

        if (page.length === 0) {
            return;
        }

        try {
            await batchHandler(page);
        } catch (err) {
            debug(`batchHandler failed for ${page.length} event(s): ${err.message}`);
            throw err;
        }
        state.eventCount += page.length;
    }

    #remainingPageSize(state) {
        return Math.min(PAGE_SIZE, state.maxEvents - state.eventCount);
    }

    get #messageStream() {
        return this.#config.messageStream || 'broadcast';
    }

    #formatDate(date) {
        return date instanceof Date ? date.toISOString() : date;
    }

    #isWithinWindow(timestamp, options) {
        const begin = options.begin && new Date(options.begin);
        const end = options.end && new Date(options.end);

        return (!begin || timestamp >= begin) && (!end || timestamp <= end);
    }

    #redact(value) {
        return String(value).replace(EMAIL_ADDRESS_PATTERN, '[redacted]');
    }
}

module.exports = PostmarkAnalyticsProvider;
