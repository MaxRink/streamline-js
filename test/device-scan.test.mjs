import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDeviceScanRequester } from '../src/modules/device-scan.js';

function recordingFetch(statusFor) {
    const calls = [];
    const fetchFn = async (url, init) => {
        calls.push([init.method, url]);
        return { status: statusFor(init.method), ok: statusFor(init.method) < 400 };
    };
    return { calls, fetchFn };
}

test('device scans use POST with the same query on a host that has the route', async () => {
    const { calls, fetchFn } = recordingFetch(() => 200);
    const scan = createDeviceScanRequester(fetchFn);

    assert.equal((await scan('/api/v1/devices/scan?connect=true')).status, 200);
    await scan('/api/v1/devices/scan');

    assert.deepEqual(calls, [
        ['POST', '/api/v1/devices/scan?connect=true'],
        ['POST', '/api/v1/devices/scan'],
    ]);
});

for (const status of [404, 405]) {
    test(`a host answering ${status} to POST gets GET once and from then on`, async () => {
        const { calls, fetchFn } = recordingFetch((method) => (method === 'POST' ? status : 200));
        const scan = createDeviceScanRequester(fetchFn);

        assert.equal((await scan('/api/v1/devices/scan')).status, 200);
        await scan('/api/v1/devices/scan?connect=true');

        assert.deepEqual(calls, [
            ['POST', '/api/v1/devices/scan'],
            ['GET', '/api/v1/devices/scan'],
            ['GET', '/api/v1/devices/scan?connect=true'],
        ]);
    });
}

test('other POST failures are returned without a GET retry', async () => {
    const { calls, fetchFn } = recordingFetch(() => 401);
    const scan = createDeviceScanRequester(fetchFn);

    assert.equal((await scan('/api/v1/devices/scan')).status, 401);
    await scan('/api/v1/devices/scan');

    assert.deepEqual(calls, [
        ['POST', '/api/v1/devices/scan'],
        ['POST', '/api/v1/devices/scan'],
    ]);
});

test('the request options, including the abort signal, reach every attempt', async () => {
    const seen = [];
    const signal = new AbortController().signal;
    const scan = createDeviceScanRequester(async (url, init) => {
        seen.push(init);
        return { status: init.method === 'POST' ? 405 : 200 };
    });

    await scan('/api/v1/devices/scan', { signal });

    assert.deepEqual(seen.map((init) => [init.method, init.signal]), [['POST', signal], ['GET', signal]]);
});
