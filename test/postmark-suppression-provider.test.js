require('should');
const sinon = require('sinon');
const {setTimeout: delay} = require('node:timers/promises');
const PostmarkSuppressionProvider = require('../PostmarkSuppressionProvider');

describe('Postmark Suppression Provider', function () {
    let sandbox;
    let client;
    let ServerClient;

    beforeEach(function () {
        sandbox = sinon.createSandbox();
        client = {
            getSuppressions: sandbox.stub(),
            deleteSuppressions: sandbox.stub()
        };
        ServerClient = sandbox.stub().returns(client);

        const originalLoad = module.constructor._load;
        sandbox.stub(module.constructor, '_load').callsFake(function (request, parent) {
            if (request === 'postmark') {
                return {ServerClient};
            }

            return originalLoad.apply(this, arguments);
        });
    });

    afterEach(function () {
        sandbox.restore();
    });

    function createProvider(config = {}) {
        return new PostmarkSuppressionProvider({serverToken: 'test-token', ...config});
    }

    it('requires a serverToken', function () {
        (() => new PostmarkSuppressionProvider({})).should.throw('Postmark suppression adapter requires serverToken in configuration');
    });

    it('declares Ghost suppression adapter methods', function () {
        createProvider().requiredFns.should.deepEqual(['getSuppressionData', 'getBulkSuppressionData', 'removeEmail']);
    });

    it('looks up suppression status on the configured message stream, defaulting to broadcast', async function () {
        client.getSuppressions.resolves({Suppressions: []});

        await createProvider().getSuppressionData('member@example.com');

        sinon.assert.calledOnceWithExactly(client.getSuppressions, 'broadcast', {emailAddress: 'member@example.com'});
    });

    it('uses the configured message stream when provided', async function () {
        client.getSuppressions.resolves({Suppressions: []});

        await createProvider({messageStream: 'newsletters'}).getSuppressionData('member@example.com');

        sinon.assert.calledOnceWithExactly(client.getSuppressions, 'newsletters', {emailAddress: 'member@example.com'});
    });

    it('maps a hard bounce suppression to a failed delivery', async function () {
        client.getSuppressions.resolves({
            Suppressions: [{
                EmailAddress: 'member@example.com',
                SuppressionReason: 'HardBounce',
                Origin: 'Recipient',
                CreatedAt: '2026-07-23T10:00:00-04:00'
            }]
        });

        const result = await createProvider().getSuppressionData('member@example.com');

        result.suppressed.should.be.true();
        result.info.reason.should.equal('fail');
        result.info.timestamp.should.be.instanceOf(Date);
        result.info.timestamp.getTime().should.equal(new Date('2026-07-23T10:00:00-04:00').getTime());
    });

    it('maps a manual suppression to a failed delivery', async function () {
        client.getSuppressions.resolves({
            Suppressions: [{
                EmailAddress: 'member@example.com',
                SuppressionReason: 'ManualSuppression',
                Origin: 'Admin',
                CreatedAt: '2026-07-23T10:00:00-04:00'
            }]
        });

        const result = await createProvider().getSuppressionData('member@example.com');

        result.info.reason.should.equal('fail');
    });

    it('maps a spam complaint suppression to spam', async function () {
        client.getSuppressions.resolves({
            Suppressions: [{
                EmailAddress: 'member@example.com',
                SuppressionReason: 'SpamComplaint',
                Origin: 'Recipient',
                CreatedAt: '2026-07-23T10:00:00-04:00'
            }]
        });

        const result = await createProvider().getSuppressionData('member@example.com');

        result.info.reason.should.equal('spam');
    });

    it('falls back to the current time when Postmark omits CreatedAt', async function () {
        client.getSuppressions.resolves({
            Suppressions: [{EmailAddress: 'member@example.com', SuppressionReason: 'HardBounce'}]
        });

        const result = await createProvider().getSuppressionData('member@example.com');

        result.info.timestamp.should.be.instanceOf(Date);
        Number.isNaN(result.info.timestamp.getTime()).should.be.false();
    });

    it('returns unsuppressed when Postmark has no matching suppression', async function () {
        client.getSuppressions.resolves({Suppressions: []});

        const result = await createProvider().getSuppressionData('member@example.com');

        result.should.deepEqual({suppressed: false, info: null});
    });

    it('propagates Postmark lookup failures instead of treating them as unsuppressed', async function () {
        const error = new Error('Access denied');
        client.getSuppressions.rejects(error);

        await createProvider().getSuppressionData('member@example.com').should.be.rejectedWith(error);
    });

    it('returns results in input order for bulk lookups', async function () {
        client.getSuppressions.onFirstCall().resolves({
            Suppressions: [{EmailAddress: 'bounce@example.com', SuppressionReason: 'HardBounce', CreatedAt: '2026-07-23T10:00:00-04:00'}]
        });
        client.getSuppressions.onSecondCall().resolves({Suppressions: []});

        const result = await createProvider().getBulkSuppressionData(['bounce@example.com', 'clear@example.com']);

        result[0].suppressed.should.be.true();
        result[0].info.reason.should.equal('fail');
        result[0].info.timestamp.should.be.instanceOf(Date);
        result[1].should.deepEqual({suppressed: false, info: null});
    });

    it('bounds concurrent lookups for a large bulk request instead of firing them all at once', async function () {
        let inFlight = 0;
        let maxInFlight = 0;

        client.getSuppressions.callsFake(async () => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await delay(5);
            inFlight -= 1;
            return {Suppressions: []};
        });

        const emails = Array.from({length: 25}, (_, index) => `member${index}@example.com`);
        const result = await createProvider().getBulkSuppressionData(emails);

        result.length.should.equal(25);
        maxInFlight.should.be.belowOrEqual(10);
        client.getSuppressions.callCount.should.equal(25);
    });

    it('removes a suppressed address', async function () {
        client.deleteSuppressions.resolves({
            Suppressions: [{EmailAddress: 'member@example.com', Status: 'Deleted', Message: null}]
        });

        const result = await createProvider().removeEmail('member@example.com');

        result.should.equal(true);
        sinon.assert.calledOnceWithExactly(client.deleteSuppressions, 'broadcast', {
            Suppressions: [{EmailAddress: 'member@example.com'}]
        });
    });

    it('returns false when Postmark reports the removal failed', async function () {
        client.deleteSuppressions.resolves({
            Suppressions: [{EmailAddress: 'member@example.com', Status: 'Failed', Message: 'SpamComplaint suppressions cannot be deleted'}]
        });

        (await createProvider().removeEmail('member@example.com')).should.equal(false);
    });

    it('returns false instead of throwing when the removal request errors', async function () {
        client.deleteSuppressions.rejects(new Error('Access denied'));

        (await createProvider().removeEmail('member@example.com')).should.equal(false);
    });
});
