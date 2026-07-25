'use strict';

const errors = require('@tryghost/errors');
const debug = require('@tryghost/debug')('email-suppression:postmark-adapter');

// Postmark has no per-address "get suppression status" endpoint - only a filterable
// dump (GET .../suppressions/dump). Ghost calls getBulkSuppressionData for every
// members-list page, potentially hundreds of emails at once - bound how many dump
// lookups are in flight together, mirroring the SES adapter's suppression provider.
const MAX_CONCURRENT_LOOKUPS = 10;

/**
 * Postmark per-message-stream suppression list adapter.
 *
 * This follows Ghost's proposed email-suppression adapter contract without
 * importing Ghost runtime classes, so it can be installed as a standalone
 * package.
 */
class PostmarkSuppressionProvider {
    #client;
    #config;

    constructor(config = {}) {
        const postmarkConfig = config.postmark || config;

        if (!postmarkConfig.serverToken) {
            throw new errors.IncorrectUsageError({
                message: 'Postmark suppression adapter requires serverToken in configuration'
            });
        }

        const {ServerClient} = require('postmark');

        Object.defineProperty(this, 'requiredFns', {
            value: ['getSuppressionData', 'getBulkSuppressionData', 'removeEmail'],
            writable: false
        });

        this.#client = new ServerClient(postmarkConfig.serverToken);
        this.#config = postmarkConfig;
    }

    async getSuppressionData(email) {
        try {
            const response = await this.#client.getSuppressions(this.#messageStream, {emailAddress: email});
            // The dump endpoint is filtered server-side to this address, but match
            // explicitly rather than trusting response[0] to be scoped correctly.
            const suppression = response?.Suppressions?.find(entry => entry.EmailAddress === email);

            if (!suppression) {
                return {suppressed: false, info: null};
            }

            return {
                suppressed: true,
                info: {
                    reason: this.#mapReason(suppression.SuppressionReason),
                    timestamp: this.#parseTimestamp(suppression.CreatedAt)
                }
            };
        } catch (err) {
            debug(`Unable to get Postmark suppression data: ${err.message}`);
            throw err;
        }
    }

    async getBulkSuppressionData(emails) {
        const results = [];

        for (let index = 0; index < emails.length; index += MAX_CONCURRENT_LOOKUPS) {
            const chunk = emails.slice(index, index + MAX_CONCURRENT_LOOKUPS);
            results.push(...await Promise.all(chunk.map(email => this.getSuppressionData(email))));
        }

        return results;
    }

    async removeEmail(email) {
        try {
            const response = await this.#client.deleteSuppressions(this.#messageStream, {
                Suppressions: [{EmailAddress: email}]
            });
            const status = response?.Suppressions?.find(entry => entry.EmailAddress === email);

            return status?.Status === 'Deleted';
        } catch (err) {
            debug(`Unable to remove Postmark suppression: ${err.message}`);
            return false;
        }
    }

    // Postmark's SuppressionReason enum has exactly three values (HardBounce,
    // SpamComplaint, ManualSuppression - postmarkapp.com/developer/api/suppressions-api).
    // Only SpamComplaint is a spam signal; HardBounce and an operator-issued
    // ManualSuppression are both non-spam delivery blocks, so both map to 'fail'.
    #mapReason(reason) {
        return reason === 'SpamComplaint' ? 'spam' : 'fail';
    }

    #parseTimestamp(value) {
        const timestamp = value ? new Date(value) : new Date();
        return Number.isNaN(timestamp.getTime()) ? new Date() : timestamp;
    }

    get #messageStream() {
        return this.#config.messageStream || 'broadcast';
    }
}

module.exports = PostmarkSuppressionProvider;
