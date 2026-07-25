require('should');
const PostmarkEmailProvider = require('..');
const PostmarkAnalyticsProvider = require('../PostmarkAnalyticsProvider');
const PostmarkSuppressionProvider = require('../PostmarkSuppressionProvider');

describe('package entry point', function () {
    it('exports PostmarkEmailProvider as the default export', function () {
        PostmarkEmailProvider.should.equal(require('../PostmarkEmailProvider'));
    });

    it('exports PostmarkAnalyticsProvider as a named property', function () {
        PostmarkEmailProvider.PostmarkAnalyticsProvider.should.equal(PostmarkAnalyticsProvider);

        const analyticsProvider = new PostmarkEmailProvider.PostmarkAnalyticsProvider({serverToken: 'test-token'});
        analyticsProvider.should.be.instanceOf(PostmarkAnalyticsProvider);
    });

    it('exports PostmarkSuppressionProvider as a named property', function () {
        PostmarkEmailProvider.PostmarkSuppressionProvider.should.equal(PostmarkSuppressionProvider);

        const suppressionProvider = new PostmarkEmailProvider.PostmarkSuppressionProvider({serverToken: 'test-token'});
        suppressionProvider.should.be.instanceOf(PostmarkSuppressionProvider);
    });
});
