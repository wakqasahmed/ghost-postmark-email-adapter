ARG PACKAGE_TARBALL

FROM ghost:6-alpine

ARG PACKAGE_TARBALL

USER root

RUN apk add --no-cache git

COPY patches/ghost-6.x-email-adapter-wiring.patch /tmp/ghost-email-adapter.patch
COPY ${PACKAGE_TARBALL} /tmp/ghost-postmark-email-adapter.tgz
COPY test/integration/entrypoint.sh /usr/local/bin/postmark-adapter-test-entrypoint
COPY test/integration/postmark-stub.js /usr/local/bin/postmark-stub.js

RUN cd /var/lib/ghost/current \
    && git apply /tmp/ghost-email-adapter.patch \
    && mkdir -p /opt/ghost-postmark-email-adapter \
    && tar -xzf /tmp/ghost-postmark-email-adapter.tgz --strip-components=1 -C /opt/ghost-postmark-email-adapter \
    && npm install --omit=dev --prefix /opt/ghost-postmark-email-adapter \
    && chmod +x /usr/local/bin/postmark-adapter-test-entrypoint

ENTRYPOINT ["postmark-adapter-test-entrypoint"]
CMD ["node", "current/index.js"]
