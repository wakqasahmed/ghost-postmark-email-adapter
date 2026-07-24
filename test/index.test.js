require('should');
const PostmarkEmailProvider = require('..');
const PostmarkAnalyticsProvider = require('../PostmarkAnalyticsProvider');

describe('package entry point', function () {
    it('exports PostmarkEmailProvider as the default export', function () {
        PostmarkEmailProvider.should.equal(require('../PostmarkEmailProvider'));
    });

    it('exports PostmarkAnalyticsProvider as a named property', function () {
        PostmarkEmailProvider.PostmarkAnalyticsProvider.should.equal(PostmarkAnalyticsProvider);

        const analyticsProvider = new PostmarkEmailProvider.PostmarkAnalyticsProvider({serverToken: 'test-token'});
        analyticsProvider.should.be.instanceOf(PostmarkAnalyticsProvider);
    });
});
