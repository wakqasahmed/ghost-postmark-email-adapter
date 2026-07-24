'use strict';

const errors = require('@tryghost/errors');
const debug = require('@tryghost/debug')('email-analytics:postmark-adapter');

const PAGE_SIZE = 500;
const EMAIL_ADDRESS_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const TEMPORARY_BOUNCE_TYPES = new Set(['Transient', 'SoftBounce', 'AutoResponder', 'DnsError', 'ChallengeVerification']);

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
        const state = {eventCount: 0, maxEvents};

        if (shouldFetch('failed') || shouldFetch('complained')) {
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

        while (state.eventCount < state.maxEvents) {
            const response = await this.#client.getBounces(new this.#postmark.BounceFilteringParameters(
                this.#remainingPageSize(state), offset, undefined, undefined, undefined, undefined, undefined,
                this.#formatDate(options.begin), this.#formatDate(options.end), this.#config.messageStream || 'broadcast'
            ));
            const bounces = response?.Bounces || [];

            if (bounces.length === 0) {
                return;
            }

            const events = [];
            for (const bounce of bounces) {
                const event = await this.#mapBounce(bounce);
                if (event && shouldFetch(event.type)) {
                    events.push(event);
                }
            }

            await this.#handlePage(batchHandler, events, state);
            offset += bounces.length;
        }
    }

    async #fetchOpens(batchHandler, options, state) {
        let offset = 0;

        while (state.eventCount < state.maxEvents) {
            const response = await this.#client.getMessageOpens(new this.#postmark.OutboundMessageOpensFilteringParameters(
                this.#remainingPageSize(state), offset, undefined, undefined, undefined, undefined, undefined,
                undefined, undefined, undefined, undefined, undefined, undefined, undefined,
                this.#config.messageStream || 'broadcast'
            ));
            const opens = response?.Opens || [];

            if (opens.length === 0) {
                return;
            }

            const events = [];
            for (const open of opens) {
                const event = await this.#mapEvent(open, 'opened', options);
                if (event) {
                    events.push(event);
                }
            }

            await this.#handlePage(batchHandler, events, state);
            offset += opens.length;
        }
    }

    async #fetchDeliveries(batchHandler, options, state) {
        let offset = 0;

        while (state.eventCount < state.maxEvents) {
            const response = await this.#client.getOutboundMessages(new this.#postmark.OutboundMessagesFilteringParameters(
                this.#remainingPageSize(state), offset, undefined, undefined, undefined, undefined,
                this.#formatDate(options.begin), this.#formatDate(options.end), undefined,
                this.#config.messageStream || 'broadcast'
            ));
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

                const details = await this.#client.getOutboundMessageDetails(providerId);
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
    }

    async #mapBounce(bounce) {
        if (bounce?.Type === 'SpamComplaint') {
            const event = await this.#mapEvent(bounce, 'complained');
            if (event) {
                event.id = `bounce:${bounce.ID}`;
            }
            return event;
        }

        const event = await this.#mapEvent(bounce, 'failed');
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

    async #mapEvent(record, type, options = {}) {
        const providerId = record?.MessageID;
        const recipientEmail = record?.Recipient || record?.Email;
        const timestamp = record?.ReceivedAt || record?.BouncedAt;

        if (!providerId || !recipientEmail || !timestamp) {
            debug(`Skipping malformed Postmark ${type} event`);
            return null;
        }

        const details = await this.#client.getOutboundMessageDetails(providerId);
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

        await batchHandler(page);
        state.eventCount += page.length;
    }

    #remainingPageSize(state) {
        return Math.min(PAGE_SIZE, state.maxEvents - state.eventCount);
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
