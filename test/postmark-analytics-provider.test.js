require('should');
const sinon = require('sinon');
const PostmarkAnalyticsProvider = require('../PostmarkAnalyticsProvider');

describe('Postmark Analytics Provider', function () {
    let sandbox;
    let client;
    let ServerClient;

    beforeEach(function () {
        sandbox = sinon.createSandbox();
        client = {
            getBounces: sandbox.stub(),
            getMessageOpens: sandbox.stub(),
            getOutboundMessageDetails: sandbox.stub(),
            getOutboundMessages: sandbox.stub()
        };
        ServerClient = sandbox.stub().returns(client);

        const originalLoad = module.constructor._load;
        sandbox.stub(module.constructor, '_load').callsFake(function (request, parent) {
            if (request === 'postmark') {
                return {
                    ServerClient,
                    BounceFilteringParameters: class BounceFilteringParameters {
                        constructor(...args) {
                            [this.count, this.offset, this.type, this.inactive, this.emailFilter, this.tag, this.messageID, this.fromDate, this.toDate, this.messageStream] = args;
                        }
                    },
                    OutboundMessageOpensFilteringParameters: class OutboundMessageOpensFilteringParameters {
                        constructor(...args) {
                            [this.count, this.offset, this.recipient, this.tag, this.clientName, this.clientCompany, this.clientFamily, this.osName, this.osFamily, this.osCompany, this.platform, this.country, this.region, this.city, this.messageStream] = args;
                        }
                    },
                    OutboundMessagesFilteringParameters: class OutboundMessagesFilteringParameters {
                        constructor(...args) {
                            [this.count, this.offset, this.recipient, this.fromEmail, this.tag, this.status, this.fromDate, this.toDate, this.subject, this.messageStream] = args;
                        }
                    }
                };
            }

            return originalLoad.apply(this, arguments);
        });
    });

    afterEach(function () {
        sandbox.restore();
    });

    function createProvider() {
        return new PostmarkAnalyticsProvider({serverToken: 'test-token'});
    }

    function emptyResponses() {
        client.getBounces.resolves({Bounces: []});
        client.getMessageOpens.resolves({Opens: []});
        client.getOutboundMessages.resolves({Messages: []});
    }

    it('requires a server token', function () {
        (() => new PostmarkAnalyticsProvider()).should.throw(/serverToken/);
    });

    it('maps bounces and complaints, redacting PII from errors', async function () {
        client.getBounces.onFirstCall().resolves({
            Bounces: [{
                ID: 1,
                Type: 'HardBounce',
                TypeCode: 1,
                MessageID: 'postmark-bounce',
                Email: 'member@example.com',
                BouncedAt: '2026-07-22T10:00:00.000Z',
                Details: '550 user member@example.com does not exist'
            }, {
                ID: 2,
                Type: 'SpamComplaint',
                MessageID: 'postmark-complaint',
                Email: 'member@example.com',
                BouncedAt: '2026-07-22T10:01:00.000Z'
            }]
        });
        client.getBounces.onSecondCall().resolves({Bounces: []});
        client.getOutboundMessageDetails.withArgs('postmark-bounce').resolves({Metadata: {'email-id': 'ghost-bounce'}});
        client.getOutboundMessageDetails.withArgs('postmark-complaint').resolves({Metadata: {'email-id': 'ghost-complaint'}});
        client.getMessageOpens.resolves({Opens: []});
        client.getOutboundMessages.resolves({Messages: []});
        const batchHandler = sinon.stub().resolves();

        await createProvider().fetchLatest(batchHandler, {
            begin: new Date('2026-07-22T00:00:00.000Z'),
            end: new Date('2026-07-23T00:00:00.000Z')
        });

        sinon.assert.calledWithMatch(batchHandler, [{
            id: 'bounce:1',
            type: 'failed',
            severity: 'permanent',
            error: {code: '1', message: '550 user [redacted] does not exist'},
            emailId: 'ghost-bounce',
            providerId: 'postmark-bounce',
            recipientEmail: 'member@example.com',
            timestamp: new Date('2026-07-22T10:00:00.000Z')
        }, {
            id: 'bounce:2',
            type: 'complained',
            emailId: 'ghost-complaint',
            providerId: 'postmark-complaint',
            recipientEmail: 'member@example.com',
            timestamp: new Date('2026-07-22T10:01:00.000Z')
        }]);
    });

    it('dispatches events oldest-first even when Postmark returns pages newest-first', async function () {
        // Simulates Postmark's real (undocumented but conventional) newest-first
        // page order: the first page fetched contains the newer events, the second
        // (older) page is fetched next since maxEvents is unbounded.
        client.getBounces.onFirstCall().resolves({
            Bounces: [{
                ID: 10,
                Type: 'HardBounce',
                MessageID: 'newer-bounce',
                Email: 'newer@example.com',
                BouncedAt: '2026-07-22T12:00:00.000Z'
            }]
        });
        client.getBounces.onSecondCall().resolves({
            Bounces: [{
                ID: 11,
                Type: 'HardBounce',
                MessageID: 'older-bounce',
                Email: 'older@example.com',
                BouncedAt: '2026-07-22T08:00:00.000Z'
            }]
        });
        client.getBounces.onThirdCall().resolves({Bounces: []});
        client.getOutboundMessageDetails.withArgs('newer-bounce').resolves({Metadata: {'email-id': 'ghost-newer'}});
        client.getOutboundMessageDetails.withArgs('older-bounce').resolves({Metadata: {'email-id': 'ghost-older'}});
        client.getMessageOpens.resolves({Opens: []});
        client.getOutboundMessages.resolves({Messages: []});
        const batchHandler = sinon.stub().resolves();

        await createProvider().fetchLatest(batchHandler, {events: ['failed']});

        sinon.assert.calledOnce(batchHandler);
        const dispatchedEvents = batchHandler.firstCall.args[0];
        dispatchedEvents.map(event => event.emailId).should.deepEqual(['ghost-older', 'ghost-newer']);
    });

    it('maps an Unsubscribe bounce record to an unsubscribed event, not failed', async function () {
        client.getBounces.onFirstCall().resolves({
            Bounces: [{
                ID: 3,
                Type: 'Unsubscribe',
                MessageID: 'postmark-unsub',
                Email: 'member@example.com',
                BouncedAt: '2026-07-22T10:05:00.000Z'
            }]
        });
        client.getBounces.onSecondCall().resolves({Bounces: []});
        client.getOutboundMessageDetails.withArgs('postmark-unsub').resolves({Metadata: {'email-id': 'ghost-unsub'}});
        const batchHandler = sinon.stub().resolves();

        await createProvider().fetchLatest(batchHandler, {events: ['unsubscribed']});

        sinon.assert.calledOnceWithExactly(batchHandler, [{
            id: 'bounce:3',
            type: 'unsubscribed',
            emailId: 'ghost-unsub',
            providerId: 'postmark-unsub',
            recipientEmail: 'member@example.com',
            timestamp: new Date('2026-07-22T10:05:00.000Z')
        }]);
    });

    it('skips non-failure administrative bounce types instead of reporting them as failed', async function () {
        client.getBounces.onFirstCall().resolves({
            Bounces: [
                {ID: 4, Type: 'AutoResponder', MessageID: 'm4', Email: 'a@example.com', BouncedAt: '2026-07-22T10:06:00.000Z'},
                {ID: 5, Type: 'Subscribe', MessageID: 'm5', Email: 'b@example.com', BouncedAt: '2026-07-22T10:06:00.000Z'},
                {ID: 6, Type: 'ChallengeVerification', MessageID: 'm6', Email: 'c@example.com', BouncedAt: '2026-07-22T10:06:00.000Z'},
                {ID: 7, Type: 'OpenRelayTest', MessageID: 'm7', Email: 'd@example.com', BouncedAt: '2026-07-22T10:06:00.000Z'}
            ]
        });
        client.getBounces.onSecondCall().resolves({Bounces: []});
        const batchHandler = sinon.stub().resolves();

        await createProvider().fetchLatest(batchHandler, {events: ['failed']});

        batchHandler.called.should.be.false();
        client.getOutboundMessageDetails.called.should.be.false();
    });

    it('pages opens, resolves metadata, and skips malformed events', async function () {
        emptyResponses();
        client.getMessageOpens.onFirstCall().resolves({
            Opens: [{
                MessageID: 'postmark-open',
                Recipient: 'member@example.com',
                ReceivedAt: '2026-07-22T10:02:00.000Z'
            }, {
                MessageID: 'missing-metadata',
                Recipient: 'member@example.com',
                ReceivedAt: '2026-07-22T10:03:00.000Z'
            }, {
                MessageID: 'malformed-open',
                ReceivedAt: 'not-a-date'
            }]
        });
        client.getMessageOpens.onSecondCall().resolves({Opens: []});
        client.getOutboundMessageDetails.withArgs('postmark-open').resolves({Metadata: {'email-id': 'ghost-open'}});
        client.getOutboundMessageDetails.withArgs('missing-metadata').resolves({Metadata: {}});
        const batchHandler = sinon.stub().resolves();

        await createProvider().fetchLatest(batchHandler, {
            begin: new Date('2026-07-22T00:00:00.000Z'),
            end: new Date('2026-07-23T00:00:00.000Z'),
            events: ['opened']
        });

        sinon.assert.calledOnceWithExactly(batchHandler, [{
            id: 'postmark-open:opened:2026-07-22T10:02:00.000Z',
            type: 'opened',
            emailId: 'ghost-open',
            providerId: 'postmark-open',
            recipientEmail: 'member@example.com',
            timestamp: new Date('2026-07-22T10:02:00.000Z')
        }]);
        client.getMessageOpens.firstCall.args[0].offset.should.equal(0);
        client.getMessageOpens.secondCall.args[0].offset.should.equal(3);
    });

    it('maps per-recipient delivered events from outbound message details', async function () {
        emptyResponses();
        client.getOutboundMessages.onFirstCall().resolves({
            Messages: [{
                MessageID: 'postmark-delivery',
                Metadata: {'email-id': 'ghost-delivery'}
            }]
        });
        client.getOutboundMessages.onSecondCall().resolves({Messages: []});
        client.getOutboundMessageDetails.withArgs('postmark-delivery').resolves({
            MessageEvents: [{
                Type: 'Delivered',
                Recipient: 'member@example.com',
                ReceivedAt: '2026-07-22T10:04:00.000Z'
            }]
        });
        const batchHandler = sinon.stub().resolves();

        await createProvider().fetchLatest(batchHandler, {
            begin: new Date('2026-07-22T00:00:00.000Z'),
            end: new Date('2026-07-23T00:00:00.000Z'),
            events: ['delivered']
        });

        sinon.assert.calledOnceWithExactly(batchHandler, [{
            id: 'postmark-delivery:delivered:member@example.com:2026-07-22T10:04:00.000Z',
            type: 'delivered',
            emailId: 'ghost-delivery',
            providerId: 'postmark-delivery',
            recipientEmail: 'member@example.com',
            timestamp: new Date('2026-07-22T10:04:00.000Z')
        }]);
    });

    it('stops paging opens at Postmark\'s 10,000-record count+offset ceiling', async function () {
        emptyResponses();
        client.getMessageOpens.callsFake(() => Promise.resolve({
            Opens: Array.from({length: 500}, () => ({MessageID: null}))
        }));
        const batchHandler = sinon.stub().resolves();

        await createProvider().fetchLatest(batchHandler, {events: ['opened']});

        client.getMessageOpens.callCount.should.equal(20);
        client.getMessageOpens.lastCall.args[0].offset.should.equal(9500);
        client.getMessageOpens.lastCall.args[0].count.should.equal(500);
    });

    it('stops paging bounces at Postmark\'s 10,000-record count+offset ceiling', async function () {
        emptyResponses();
        client.getBounces.callsFake(() => Promise.resolve({
            Bounces: Array.from({length: 500}, () => ({Type: 'AutoResponder'}))
        }));
        const batchHandler = sinon.stub().resolves();

        await createProvider().fetchLatest(batchHandler, {events: ['failed']});

        client.getBounces.callCount.should.equal(20);
        client.getBounces.lastCall.args[0].offset.should.equal(9500);
        client.getBounces.lastCall.args[0].count.should.equal(500);
    });

    it('stops paging deliveries at Postmark\'s 10,000-record count+offset ceiling', async function () {
        emptyResponses();
        client.getOutboundMessages.callsFake(() => Promise.resolve({
            Messages: Array.from({length: 500}, () => ({MessageID: null}))
        }));
        const batchHandler = sinon.stub().resolves();

        await createProvider().fetchLatest(batchHandler, {events: ['delivered']});

        client.getOutboundMessages.callCount.should.equal(20);
        client.getOutboundMessages.lastCall.args[0].offset.should.equal(9500);
        client.getOutboundMessages.lastCall.args[0].count.should.equal(500);
    });

    it('caches getOutboundMessageDetails per message within one fetchLatest call', async function () {
        client.getBounces.onFirstCall().resolves({
            Bounces: [{
                ID: 8,
                Type: 'SpamComplaint',
                MessageID: 'shared-message',
                Email: 'member@example.com',
                BouncedAt: '2026-07-22T10:07:00.000Z'
            }]
        });
        client.getBounces.onSecondCall().resolves({Bounces: []});
        client.getMessageOpens.onFirstCall().resolves({
            Opens: [{
                MessageID: 'shared-message',
                Recipient: 'member@example.com',
                ReceivedAt: '2026-07-22T10:08:00.000Z'
            }]
        });
        client.getMessageOpens.onSecondCall().resolves({Opens: []});
        client.getOutboundMessages.resolves({Messages: []});
        client.getOutboundMessageDetails.withArgs('shared-message').resolves({Metadata: {'email-id': 'ghost-shared'}});
        const batchHandler = sinon.stub().resolves();

        await createProvider().fetchLatest(batchHandler, {events: ['complained', 'opened']});

        client.getOutboundMessageDetails.withArgs('shared-message').callCount.should.equal(1);
    });

    it('stops when maxEvents is reached', async function () {
        client.getBounces.resolves({
            Bounces: [{
                ID: 1,
                Type: 'HardBounce',
                TypeCode: 1,
                MessageID: 'postmark-bounce',
                Email: 'member@example.com',
                BouncedAt: '2026-07-22T10:00:00.000Z'
            }, {
                ID: 2,
                Type: 'SoftBounce',
                TypeCode: 4096,
                MessageID: 'postmark-bounce-2',
                Email: 'second@example.com',
                BouncedAt: '2026-07-22T10:01:00.000Z'
            }]
        });
        client.getOutboundMessageDetails.withArgs('postmark-bounce').resolves({Metadata: {'email-id': 'ghost-bounce'}});
        const batchHandler = sinon.stub().resolves();

        await createProvider().fetchLatest(batchHandler, {maxEvents: 1, events: ['failed']});

        sinon.assert.calledOnce(batchHandler);
        client.getMessageOpens.called.should.be.false();
        client.getOutboundMessages.called.should.be.false();
    });
});
