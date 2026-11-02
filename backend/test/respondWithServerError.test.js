const { test } = require('node:test');
const assert = require('node:assert/strict');
const { respondWithServerError } = require('../src/utils/respondWithServerError');

test('server error responses and diagnostics omit raw internal messages', () => {
    const logged = [];
    const originalError = console.error;
    console.error = (...args) => logged.push(args);
    const response = {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };
    const internal = Object.assign(new Error('sensitive database detail'), { code: 'ER_ACCESS_DENIED_ERROR' });

    try {
        respondWithServerError(response, internal, 'test.operation');
    } finally {
        console.error = originalError;
    }

    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.body, { error: 'An internal server error occurred.' });
    assert.equal(JSON.stringify(logged).includes('sensitive database detail'), false);
    assert.equal(JSON.stringify(logged).includes('ER_ACCESS_DENIED_ERROR'), true);
});
