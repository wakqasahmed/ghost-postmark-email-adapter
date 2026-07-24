require('should');
const sinon = require('sinon');
const EmailProviderBase = require('../EmailProviderBase');

describe('Postmark Email Provider Adapter', function () {
    let PostmarkEmailProvider;
    let postmarkClient;
    let ServerClientStub;
    let sandbox;

    beforeEach(function () {
        sandbox = sinon.createSandbox();
        postmarkClient = {
            sendEmailBatch: sandbox.stub().callsFake(function (messages) {
                return Promise.resolve(messages.map(function (message, index) {
                    return {ErrorCode: 0, MessageID: `message-${index + 1}`};
                }));
            })
        };
        ServerClientStub = sandbox.stub().returns(postmarkClient);

        const originalLoad = module.constructor._load;
        sandbox.stub(module.constructor, '_load').callsFake(function (request, parent) {
            if (request === 'postmark') {
                return {
                    ServerClient: ServerClientStub,
                    Models: {
                        ClientOptions: {
                            Configuration: function (useHttps, requestHost) {
                                this.useHttps = useHttps;
                                this.requestHost = requestHost;
                            }
                        }
                    }
                };
            }

            return originalLoad.apply(this, arguments);
        });

        delete require.cache[require.resolve('..')];
        delete require.cache[require.resolve('../PostmarkEmailProvider')];
        PostmarkEmailProvider = require('..');
    });

    afterEach(function () {
        sandbox.restore();
        delete require.cache[require.resolve('..')];
        delete require.cache[require.resolve('../PostmarkEmailProvider')];
    });

    function createAdapter(config = {}) {
        return new PostmarkEmailProvider({
            postmark: {
                serverToken: 'server-token',
                fromEmail: 'news@example.com',
                ...config
            }
        });
    }

    function createEmailData(recipients = [{email: 'member@example.com'}]) {
        return {
            subject: 'Monthly news',
            html: '<p>Hello %%name%%</p><a href="%%list_unsubscribe%%">Unsubscribe</a>',
            plaintext: 'Hello %%name%%',
            from: 'Newsletter <news@example.com>',
            replyTo: 'replies@example.com',
            emailId: 'ghost-email-123',
            recipients,
            replacementDefinitions: [
                {id: 'name', token: '%%name%%'},
                {id: 'list_unsubscribe', token: '%%list_unsubscribe%%'}
            ]
        };
    }

    describe('constructor', function () {
        it('extends EmailProviderBase and accepts flat config', function () {
            const adapter = new PostmarkEmailProvider({
                serverToken: 'server-token',
                fromEmail: 'news@example.com'
            });

            adapter.should.be.instanceOf(EmailProviderBase);
        });

        ['serverToken', 'fromEmail'].forEach(function (field) {
            it(`rejects a missing ${field}`, function () {
                const config = {serverToken: 'server-token', fromEmail: 'news@example.com'};
                delete config[field];

                (function () {
                    return new PostmarkEmailProvider({postmark: config});
                }).should.throw(/Postmark adapter requires/);
            });
        });

        it('uses the default Postmark host when requestHost is not configured', function () {
            new PostmarkEmailProvider({serverToken: 'server-token', fromEmail: 'news@example.com'});

            ServerClientStub.firstCall.args.should.deepEqual(['server-token', undefined]);
        });

        it('redirects the client to requestHost over plain HTTP when configured', function () {
            new PostmarkEmailProvider({
                serverToken: 'server-token',
                fromEmail: 'news@example.com',
                requestHost: '127.0.0.1:2500'
            });

            const clientOptions = ServerClientStub.firstCall.args[1];
            clientOptions.useHttps.should.equal(false);
            clientOptions.requestHost.should.equal('127.0.0.1:2500');
        });
    });

    describe('send()', function () {
        it('sends personalized messages with configured Postmark fields and unsubscribe headers', async function () {
            const adapter = createAdapter({messageStream: 'newsletter'});
            const data = createEmailData([{
                email: 'member@example.com',
                replacements: [
                    {id: 'name', value: '<Member & Co>'},
                    {id: 'list_unsubscribe', value: 'https://example.com/unsubscribe/member'}
                ]
            }]);

            const result = await adapter.send(data, {
                openTrackingEnabled: true,
                clickTrackingEnabled: true
            });

            result.should.deepEqual({id: 'message-1'});
            postmarkClient.sendEmailBatch.calledOnce.should.be.true();
            postmarkClient.sendEmailBatch.firstCall.args[0].should.deepEqual([{
                From: 'Newsletter <news@example.com>',
                To: 'member@example.com',
                Subject: 'Monthly news',
                HtmlBody: '<p>Hello &lt;Member &amp; Co&gt;</p><a href="https:&#x2F;&#x2F;example.com&#x2F;unsubscribe&#x2F;member">Unsubscribe</a>',
                TextBody: 'Hello <Member & Co>',
                ReplyTo: 'replies@example.com',
                MessageStream: 'newsletter',
                TrackOpens: true,
                TrackLinks: 'HtmlAndText',
                Metadata: {'email-id': 'ghost-email-123'},
                Headers: [
                    {Name: 'List-Unsubscribe', Value: '<https://example.com/unsubscribe/member>'},
                    {Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click'}
                ]
            }]);
        });

        it('sends both batches when two concurrent sends share the same emailId but have different recipients', async function () {
            const adapter = createAdapter();
            const dataA = createEmailData([{email: 'a1@example.com'}, {email: 'a2@example.com'}]);
            const dataB = createEmailData([{email: 'b1@example.com'}, {email: 'b2@example.com'}]);

            await Promise.all([
                adapter.send(dataA, {}),
                adapter.send(dataB, {})
            ]);

            postmarkClient.sendEmailBatch.callCount.should.equal(2);

            const sentTo = postmarkClient.sendEmailBatch.getCalls()
                .map(call => call.args[0].map(message => message.To))
                .flat();
            sentTo.should.containDeep(['a1@example.com', 'a2@example.com', 'b1@example.com', 'b2@example.com']);
        });

        it('chunks batch sends at 500 recipients and uses default broadcast stream', async function () {
            const adapter = createAdapter();
            const recipients = Array.from({length: 501}, function (_, index) {
                return {email: `member${index}@example.com`};
            });

            await adapter.send(createEmailData(recipients), {});

            postmarkClient.sendEmailBatch.callCount.should.equal(2);
            postmarkClient.sendEmailBatch.firstCall.args[0].length.should.equal(500);
            postmarkClient.sendEmailBatch.secondCall.args[0].length.should.equal(1);
            postmarkClient.sendEmailBatch.firstCall.args[0][0].MessageStream.should.equal('broadcast');
            postmarkClient.sendEmailBatch.firstCall.args[0][0].TrackOpens.should.be.false();
            postmarkClient.sendEmailBatch.firstCall.args[0][0].TrackLinks.should.equal('None');
        });

        it('retries only recipients that had per-message failures and redacts their addresses', async function () {
            const adapter = createAdapter();
            const recipients = [
                {email: 'delivered@example.com'},
                {email: 'private.member@example.com'}
            ];
            const data = createEmailData(recipients);
            postmarkClient.sendEmailBatch.onFirstCall().resolves([
                {ErrorCode: 0, MessageID: 'delivered-id'},
                {ErrorCode: 406, Message: 'Inactive private.member@example.com'}
            ]);
            postmarkClient.sendEmailBatch.onSecondCall().resolves([
                {ErrorCode: 0, MessageID: 'retried-id'}
            ]);

            try {
                await adapter.send(data, {});
                throw new Error('Expected EmailError');
            } catch (err) {
                err.name.should.equal('EmailError');
                err.code.should.equal('BULK_EMAIL_SEND_FAILED');
                err.message.should.not.containEql('private.member@example.com');
                err.errorDetails.should.not.containEql('private.member@example.com');
                err.errorDetails.length.should.be.belowOrEqual(2000);
            }

            const result = await adapter.send(data, {});
            result.should.deepEqual({id: 'retried-id'});
            postmarkClient.sendEmailBatch.callCount.should.equal(2);
            postmarkClient.sendEmailBatch.secondCall.args[0].map(function (message) {
                return message.To;
            }).should.deepEqual(['private.member@example.com']);
        });

        it('attempts every chunk even when an earlier chunk has failures', async function () {
            const adapter = createAdapter();
            const recipients = Array.from({length: 1200}, function (_, index) {
                return {email: `member${index}@example.com`};
            });

            postmarkClient.sendEmailBatch.onFirstCall().resolves([
                {ErrorCode: 406, Message: 'Inactive member0@example.com'},
                ...Array.from({length: 499}, (_, index) => ({ErrorCode: 0, MessageID: `chunk1-${index}`}))
            ]);
            postmarkClient.sendEmailBatch.onSecondCall().resolves(
                Array.from({length: 500}, (_, index) => ({ErrorCode: 0, MessageID: `chunk2-${index}`}))
            );
            postmarkClient.sendEmailBatch.onThirdCall().resolves(
                Array.from({length: 200}, (_, index) => ({ErrorCode: 0, MessageID: `chunk3-${index}`}))
            );

            try {
                await adapter.send(createEmailData(recipients), {});
                throw new Error('Expected EmailError');
            } catch (err) {
                err.name.should.equal('EmailError');
                err.statusCode.should.equal(400);
            }

            postmarkClient.sendEmailBatch.callCount.should.equal(3);
        });

        it('reports a whole-chunk invoke failure as a 400 without skipping later chunks', async function () {
            const adapter = createAdapter();
            const recipients = Array.from({length: 600}, function (_, index) {
                return {email: `member${index}@example.com`};
            });

            postmarkClient.sendEmailBatch.onFirstCall().rejects(new Error('Postmark API unavailable'));
            postmarkClient.sendEmailBatch.onSecondCall().resolves([
                {ErrorCode: 0, MessageID: 'chunk2-0'}
            ]);

            try {
                await adapter.send(createEmailData(recipients), {});
                throw new Error('Expected EmailError');
            } catch (err) {
                err.name.should.equal('EmailError');
                err.message.should.containEql('Postmark API unavailable');
            }

            postmarkClient.sendEmailBatch.callCount.should.equal(2);
        });
    });

    describe('provider limits', function () {
        it('reports Postmark batch capacity and an hour delivery window', function () {
            const adapter = createAdapter();

            adapter.getMaximumRecipients().should.equal(500);
            adapter.getTargetDeliveryWindow().should.equal(3600);
        });
    });
});
