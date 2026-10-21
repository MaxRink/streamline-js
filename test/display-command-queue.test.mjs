import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('../src/modules/api.js', import.meta.url), 'utf8');
const pick = (pattern) => {
    const match = source.match(pattern);
    assert.ok(match);
    return match[0];
};
const stateSource = [
    pick(/let displayWebSocket = null;/),
    pick(/let displayWebSocketReady = false;/),
    pick(/let pendingDisplayCommand = null;/),
    pick(/let pendingBrightnessCommand = null;/),
    pick(/let lastDisplayState = null;/),
    pick(/const displayListeners = new Set\(\);/),
].join('\n');
const functionStart = source.indexOf('export function connectDisplayWebSocket');
const functionEnd = source.indexOf('export function getDisplayWebSocket', functionStart);
assert.notEqual(functionStart, -1);
assert.notEqual(functionEnd, -1);
const functionSource = source.slice(functionStart, functionEnd).replaceAll('export ', '');

test('the latest display command waits for the reconnecting socket to open', () => {
    let readyState = 0;
    let payload;
    const sent = [];
    const socket = {
        get readyState() { return readyState; },
        send(value) { payload = value; sent.push(value); },
    };
    const ReconnectingWebSocket = function() { return socket; };
    const { connectDisplayWebSocket, sendDisplayCommand } = new Function(
        'ReconnectingWebSocket',
        'WebSocket',
        'WS_PROTOCOL',
        'reaHostname',
        'REA_PORT',
        'RECONNECT_POLICY',
        'logger',
        'isWakeLockEnabled',
        'enableWakeLock',
        `${stateSource}\n${functionSource}\nreturn { connectDisplayWebSocket, sendDisplayCommand };`,
    )(
        ReconnectingWebSocket,
        { OPEN: 1 },
        'ws:',
        'decaid',
        8080,
        { critical: {}, standard: {}, background: {} },
        { error() {}, info() {}, warn() {} },
        () => false,
        async () => {},
    );
    const dim = { command: 'setBrightness', brightness: 0 };
    const restore = { command: 'setBrightness', brightness: 75 };

    connectDisplayWebSocket();
    assert.equal(sendDisplayCommand(dim), 'queued');
    assert.equal(sendDisplayCommand(restore), 'queued');
    assert.equal(payload, undefined);

    readyState = 1;
    socket.onopen();
    assert.equal(payload, JSON.stringify(restore));
    sent.length = 0;
    readyState = 0;
    const wake = { command: 'requestWakeLock' };
    assert.equal(sendDisplayCommand(restore), 'queued');
    assert.equal(sendDisplayCommand(wake), 'queued');
    assert.equal(sendDisplayCommand(dim), 'queued');
    readyState = 1;
    socket.onopen();
    assert.deepEqual(sent, [JSON.stringify(wake), JSON.stringify(dim)], 'a queued brightness survives another command');
    assert.equal(sendDisplayCommand(dim), 'sent', 'an open socket reports the write as sent');
    assert.equal(payload, JSON.stringify(dim));
});
