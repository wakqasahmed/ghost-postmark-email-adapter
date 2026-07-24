#!/usr/bin/env bash

set -euo pipefail

readonly repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly run_id="${RANDOM}${RANDOM}"
readonly container_name="postmark-adapter-test-ghost-${run_id}"
readonly image_name="postmark-adapter-test-ghost:${run_id}"
readonly temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/postmark-adapter-test-XXXXXX")"

cleanup() {
    docker rm --force --volumes "$container_name" >/dev/null 2>&1 || true
    docker image rm --force "$image_name" >/dev/null 2>&1 || true
    rm -rf "$temp_dir"
}

trap cleanup EXIT INT TERM

build_context="$temp_dir/build-context"
mkdir -p "$build_context/patches"
cp "$repo_root/patches/ghost-6.x-email-adapter-wiring.patch" "$build_context/patches/"
mkdir -p "$build_context/test/integration"
cp "$repo_root/test/integration/entrypoint.sh" "$build_context/test/integration/"
cp "$repo_root/test/integration/postmark-stub.js" "$build_context/test/integration/"

npm pack --silent --pack-destination "$build_context" "$repo_root" >/dev/null
package_tarball="$(find "$build_context" -maxdepth 1 -name 'ghost-postmark-email-adapter-*.tgz' -printf '%f\n' -quit)"

if [[ -z "$package_tarball" ]]; then
    echo 'npm pack did not produce the adapter tarball.' >&2
    exit 1
fi

cp "$repo_root/test/integration/Dockerfile" "$build_context/Dockerfile"

if ! docker build \
    --quiet \
    --tag "$image_name" \
    --build-arg "PACKAGE_TARBALL=$package_tarball" \
    --file "$build_context/Dockerfile" \
    "$build_context" >/dev/null; then
    echo 'FAILURE_STAGE=patch-apply-or-build' >&2
    echo 'docker build failed - likely the wiring patch did not apply to the current ghost:6-alpine runtime.' >&2
    exit 1
fi

docker run --detach --name "$container_name" \
    --tmpfs /var/lib/ghost/content:uid=1000,gid=1000,mode=0755 \
    --env NODE_ENV=production \
    --env url=http://127.0.0.1:2368 \
    --env database__client=sqlite3 \
    --env database__connection__filename=/var/lib/ghost/content/data/ghost.db \
    --env adapters__email__active=postmark \
    --env adapters__email__postmark__serverToken=fake-integration-test-token \
    --env adapters__email__postmark__fromEmail=news@example.test \
    --env adapters__email__postmark__messageStream=broadcast \
    --env adapters__email__postmark__requestHost=127.0.0.1:2500 \
    "$image_name" >/dev/null

for _ in $(seq 1 60); do
    if docker logs "$container_name" 2>&1 | grep -q 'Ghost is running'; then
        if docker exec -i "$container_name" node - <<'NODE'
const adapterManager = require('/var/lib/ghost/current/core/server/services/adapter-manager');
const fs = require('fs');

async function main() {
    const adapter = adapterManager.getAdapter('email');

    if (adapter.constructor.name !== 'PostmarkEmailProvider') {
        console.error('FAILURE_STAGE=adapter-not-resolved');
        throw new Error(`Expected PostmarkEmailProvider, received ${adapter.constructor.name}`);
    }

    console.log(`ADAPTER_CONSTRUCTOR=${adapter.constructor.name}`);

    let result;
    try {
        result = await adapter.send({
            subject: 'Integration check',
            html: '<p>Hello</p>',
            plaintext: 'Hello',
            from: 'news@example.test',
            emailId: 'integration-check-email',
            recipients: [{email: 'member@example.test'}],
            replacementDefinitions: []
        }, {openTrackingEnabled: true, clickTrackingEnabled: true});
    } catch (err) {
        console.error('FAILURE_STAGE=send-rejected');
        throw err;
    }

    if (typeof result.id !== 'string' || !result.id) {
        console.error('FAILURE_STAGE=send-payload-mismatch');
        throw new Error(`Expected adapter.send() to resolve with a string id, received ${JSON.stringify(result)}`);
    }

    let captured;
    try {
        captured = JSON.parse(fs.readFileSync('/tmp/postmark-requests.json', 'utf8'));
    } catch (err) {
        console.error('FAILURE_STAGE=send-payload-mismatch');
        throw new Error(`Expected the Postmark stub to have captured a request: ${err.message}`);
    }

    if (!Array.isArray(captured) || captured.length !== 1) {
        console.error('FAILURE_STAGE=send-payload-mismatch');
        throw new Error(`Expected exactly one captured message, received ${JSON.stringify(captured)}`);
    }

    const [message] = captured;
    const expectations = {
        MessageStream: 'broadcast',
        TrackOpens: true,
        TrackLinks: 'HtmlAndText'
    };

    for (const [field, expected] of Object.entries(expectations)) {
        if (message[field] !== expected) {
            console.error('FAILURE_STAGE=send-payload-mismatch');
            throw new Error(`Expected ${field}=${JSON.stringify(expected)}, received ${JSON.stringify(message[field])}`);
        }
    }

    if (!message.Metadata || message.Metadata['email-id'] !== 'integration-check-email') {
        console.error('FAILURE_STAGE=send-payload-mismatch');
        throw new Error(`Expected Metadata['email-id']=integration-check-email, received ${JSON.stringify(message.Metadata)}`);
    }

    console.log(`ADAPTER_SEND_OK=${result.id}`);
}

main().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
});
NODE
        then
            exit 0
        else
            docker logs "$container_name" >&2
            exit 1
        fi
    fi

    sleep 1
done

echo 'FAILURE_STAGE=ghost-boot-timeout' >&2
docker logs "$container_name" >&2
echo 'Ghost did not report a successful boot within 60 seconds.' >&2
exit 1
