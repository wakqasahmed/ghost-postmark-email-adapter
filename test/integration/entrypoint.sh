#!/bin/sh

set -eu

adapter_path=/var/lib/ghost/content/adapters/email/postmark
mkdir -p "$(dirname "$adapter_path")"
cp -a /opt/ghost-postmark-email-adapter "$adapter_path"
chown -R node:node /var/lib/ghost/content/adapters

# Start the local Postmark API stub before Ghost boots. Ghost's own process
# stays foreground via docker-entrypoint.sh below; this stub runs alongside it
# for the lifetime of the container so a later docker exec can trigger a send.
node /usr/local/bin/postmark-stub.js &

exec docker-entrypoint.sh "$@"
