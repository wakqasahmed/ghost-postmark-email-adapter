const crypto = require('node:crypto');
const debug = require('@tryghost/debug')('email-service:postmark-adapter');
const errors = require('@tryghost/errors');
const EmailProviderBase = require('./EmailProviderBase');

const BATCH_SIZE = 500;
const MAX_RETRY_STATE_ENTRIES = 1000;

class PostmarkEmailProvider extends EmailProviderBase {
    #client;
    #postmarkConfig;
    #errorHandler;
    #successfulRecipients = new Map();
    #inFlightSends = new Map();

    constructor(config) {
        super(config);

        const rootConfig = config || {};
        const postmarkConfig = rootConfig.postmark || rootConfig;

        if (!postmarkConfig.serverToken) {
            throw new errors.IncorrectUsageError({
                message: 'Postmark adapter requires serverToken in configuration'
            });
        }

        if (!postmarkConfig.fromEmail) {
            throw new errors.IncorrectUsageError({
                message: 'Postmark adapter requires fromEmail in configuration'
            });
        }

        const {ServerClient, Models} = require('postmark');

        // requestHost is undocumented in this adapter's public config surface - it exists
        // only so the disposable integration check can redirect the client at a local stub
        // instead of api.postmarkapp.com. Omitting it preserves default behavior exactly.
        // Env-var config values are always strings, so a boolean "useHttps" override isn't
        // exposed here - requestHost always implies plain HTTP, which is the only case this
        // exists for.
        const clientOptions = postmarkConfig.requestHost
            ? new Models.ClientOptions.Configuration(false, postmarkConfig.requestHost)
            : undefined;

        this.#client = new ServerClient(postmarkConfig.serverToken, clientOptions);
        this.#postmarkConfig = postmarkConfig;
        this.#errorHandler = rootConfig.errorHandler;
    }

    #escapeHtml(value) {
        const htmlEscapes = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            '\'': '&#x27;',
            '/': '&#x2F;'
        };

        return String(value).replace(/[&<>"'/]/g, function (character) {
            return htmlEscapes[character];
        });
    }

    #sanitizeHeader(value) {
        return String(value || '').replace(/[\r\n]/g, '');
    }

    #processReplacements(content, replacements = [], replacementDefinitions = [], isHtml = false) {
        if (!content || replacements.length === 0) {
            return content;
        }

        let processedContent = content;

        for (const replacement of replacements) {
            const token = replacement.token || replacementDefinitions.find(function (definition) {
                return definition.id === replacement.id;
            })?.token;

            if (!token) {
                continue;
            }

            let value = replacement.value === null || replacement.value === undefined ? '' : String(replacement.value);
            if (isHtml) {
                value = this.#escapeHtml(value);
            }

            const tokenRegex = token instanceof RegExp
                ? new RegExp(token.source, token.flags.includes('g') ? token.flags : `${token.flags}g`)
                : new RegExp(String(token).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
            processedContent = processedContent.replace(tokenRegex, function () {
                return value;
            });
        }

        return processedContent;
    }

    #getListUnsubscribeUrl(replacements = []) {
        const replacement = replacements.find(function (item) {
            return item.id === 'list_unsubscribe';
        });

        return replacement?.value ? this.#sanitizeHeader(replacement.value).trim() : '';
    }

    #buildHeaders(listUnsubscribe) {
        if (!listUnsubscribe) {
            return undefined;
        }

        const headers = [{Name: 'List-Unsubscribe', Value: `<${listUnsubscribe}>`}];
        if (listUnsubscribe.startsWith('https://')) {
            headers.push({Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click'});
        }

        return headers;
    }

    #buildMessage(data, options, recipient, replacementDefinitions) {
        const listUnsubscribe = this.#getListUnsubscribeUrl(recipient.replacements);
        const message = {
            From: this.#sanitizeHeader(data.from || this.#postmarkConfig.fromEmail),
            To: this.#sanitizeHeader(recipient.email),
            Subject: this.#sanitizeHeader(data.subject),
            HtmlBody: this.#processReplacements(data.html, recipient.replacements, replacementDefinitions, true),
            TextBody: this.#processReplacements(data.plaintext, recipient.replacements, replacementDefinitions),
            MessageStream: this.#postmarkConfig.messageStream || 'broadcast',
            TrackOpens: !!options.openTrackingEnabled,
            TrackLinks: options.clickTrackingEnabled ? 'HtmlAndText' : 'None',
            Metadata: {'email-id': String(data.emailId || 'unknown')}
        };

        if (data.replyTo) {
            message.ReplyTo = this.#sanitizeHeader(data.replyTo);
        }

        const headers = this.#buildHeaders(listUnsubscribe);
        if (headers) {
            message.Headers = headers;
        }

        return message;
    }

    // Ghost sends one newsletter as multiple concurrent batches that all share the
    // same emailId (batch-sending-service.js runs up to 2 workers at once). Keying
    // retry/in-flight state on emailId alone made two different batches of the same
    // email collide - one batch's promise was silently returned to the other caller,
    // and its recipients were never sent. Folding a recipient-set digest into the key
    // keeps genuine retries of the same batch coalescing correctly while giving every
    // distinct batch its own key.
    #getRetryKey({emailId, idempotencyKey, subject, html, plaintext, from, replyTo, recipients, replacementDefinitions, options}) {
        const recipientDigest = crypto.createHash('sha256')
            .update(recipients.map(recipient => recipient.email).sort().join(','))
            .digest('hex');

        if (emailId) {
            return `email:${emailId}:${recipientDigest}`;
        }

        if (idempotencyKey) {
            return `idempotency:${idempotencyKey}:${recipientDigest}`;
        }

        const payload = JSON.stringify({subject, html, plaintext, from, replyTo, recipients, replacementDefinitions, options});
        return `payload:${crypto.createHash('sha256').update(payload).digest('hex')}`;
    }

    #rememberSuccessfulRecipients(retryKey, successfulRecipients) {
        this.#successfulRecipients.delete(retryKey);
        this.#successfulRecipients.set(retryKey, successfulRecipients);

        if (this.#successfulRecipients.size > MAX_RETRY_STATE_ENTRIES) {
            this.#successfulRecipients.delete(this.#successfulRecipients.keys().next().value);
        }
    }

    #chunkArray(array) {
        const chunks = [];
        for (let index = 0; index < array.length; index += BATCH_SIZE) {
            chunks.push(array.slice(index, index + BATCH_SIZE));
        }

        return chunks;
    }

    #redactPII(value, recipients = []) {
        let redactedValue = String(value || 'Postmark Error');

        for (const recipient of recipients) {
            redactedValue = redactedValue.split(String(recipient.email)).join('[redacted]');
        }

        return redactedValue.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted]');
    }

    #createError(error, recipients) {
        const statusCode = error.statusCode || error.$metadata?.httpStatusCode || 500;
        const message = this.#redactPII(error.message, recipients).slice(0, 2000);
        const errorDetails = JSON.stringify({
            error: {
                name: this.#redactPII(error.name, recipients),
                message,
                code: this.#redactPII(error.code, recipients),
                statusCode
            },
            recipientCount: recipients.length
        }).slice(0, 2000);
        const sanitizedError = new Error(message);
        sanitizedError.name = this.#redactPII(error.name, recipients);
        sanitizedError.code = this.#redactPII(error.code, recipients);
        sanitizedError.statusCode = statusCode;

        return new errors.EmailError({
            statusCode,
            message,
            errorDetails,
            context: `Postmark Error: ${message}`,
            help: 'https://ghost.org/docs/newsletters/#bulk-email-configuration',
            code: 'BULK_EMAIL_SEND_FAILED',
            err: sanitizedError
        });
    }

    #notifyErrorHandler(ghostError) {
        if (this.#errorHandler) {
            try {
                Promise.resolve(this.#errorHandler(ghostError)).catch(function (handlerError) {
                    debug(`errorHandler rejected: ${handlerError?.message}`);
                });
            } catch (handlerError) {
                debug(`errorHandler threw: ${handlerError?.message}`);
            }
        }
    }

    async #send(data, options, retryKey) {
        const recipients = data.recipients || [];
        const replacementDefinitions = data.replacementDefinitions || [];
        const successfulRecipients = this.#successfulRecipients.get(retryKey) || new Set();
        const pendingRecipients = recipients.filter(function (recipient) {
            return !successfulRecipients.has(recipient.email);
        });
        let firstMessageId;
        const failures = [];

        // Every chunk is attempted even after an earlier chunk fails, so one bad
        // recipient (or one failed batch call) never silently skips the rest of a
        // large send - mirrors SESEmailProvider's Promise.allSettled-per-batch approach.
        for (const batch of this.#chunkArray(pendingRecipients)) {
            let results;

            try {
                results = await this.#client.sendEmailBatch(batch.map((recipient) => {
                    return this.#buildMessage(data, options, recipient, replacementDefinitions);
                }));
            } catch (error) {
                failures.push({message: error.message, code: error.code});
                continue;
            }

            results.forEach(function (result, index) {
                if (result.ErrorCode === 0) {
                    successfulRecipients.add(batch[index].email);
                    firstMessageId = firstMessageId || result.MessageID;
                } else {
                    failures.push({message: result.Message || `Postmark error ${result.ErrorCode}`, code: result.ErrorCode});
                }
            });
        }

        if (failures.length > 0) {
            this.#rememberSuccessfulRecipients(retryKey, successfulRecipients);

            const error = new Error(failures.map(failure => failure.message).join('; '));
            error.code = failures[0].code;
            // Per-recipient content/address rejections are a client-side condition, not a
            // Postmark outage - distinguish them from the createError() default of 500.
            error.statusCode = 400;

            const ghostError = this.#createError(error, recipients);
            this.#notifyErrorHandler(ghostError);
            throw ghostError;
        }

        this.#successfulRecipients.delete(retryKey);
        debug(`sent ${recipients.length} messages through Postmark`);

        return {id: firstMessageId || 'unknown'};
    }

    async send(data, options = {}) {
        const retryKey = this.#getRetryKey({...data, options});
        const inFlightSend = this.#inFlightSends.get(retryKey);

        if (inFlightSend) {
            return inFlightSend;
        }

        const sendPromise = this.#send(data, options, retryKey);
        this.#inFlightSends.set(retryKey, sendPromise);

        try {
            return await sendPromise;
        } finally {
            if (this.#inFlightSends.get(retryKey) === sendPromise) {
                this.#inFlightSends.delete(retryKey);
            }
        }
    }

    getMaximumRecipients() {
        return BATCH_SIZE;
    }

    getTargetDeliveryWindow() {
        // Ghost core treats this as milliseconds and uses it to spread batches
        // across a delivery window (see batch-sending-service.js). This adapter
        // sends immediately and cannot honor a delivery-time hint, so return 0
        // to skip Ghost's windowing/spreading logic entirely (Ghost treats
        // targetDeliveryWindow <= 0 as "no deadline").
        return 0;
    }
}

module.exports = PostmarkEmailProvider;
