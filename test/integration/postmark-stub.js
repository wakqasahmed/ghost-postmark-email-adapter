'use strict';

const http = require('node:http');
const fs = require('node:fs');

const PORT = 2500;
const LOG_PATH = '/tmp/postmark-requests.json';

const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/email/batch') {
        res.writeHead(404).end();
        return;
    }

    if (!req.headers['x-postmark-server-token']) {
        res.writeHead(401, {'Content-Type': 'application/json'}).end(JSON.stringify({ErrorCode: 10, Message: 'Missing server token'}));
        return;
    }

    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
        let messages;

        try {
            messages = JSON.parse(body);
        } catch {
            res.writeHead(400).end();
            return;
        }

        fs.writeFileSync(LOG_PATH, JSON.stringify(messages, null, 2));

        const response = messages.map((message, index) => ({
            ErrorCode: 0,
            Message: 'OK',
            MessageID: `stub-message-id-${index}`,
            SubmittedAt: new Date().toISOString(),
            To: message.To
        }));

        res.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify(response));
    });
});

if (require.main === module) {
    server.listen(PORT, '127.0.0.1', () => {
        console.log(`postmark-stub listening on 127.0.0.1:${PORT}`);
    });
}

module.exports = server;
