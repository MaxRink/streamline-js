// The vendored ReconnectingWebSocket used to ignore its own close().
//
// socket-slot.js promises close-before-open: "a resync cannot leak a socket".
// That promise rested on close() being final, and in the stock joewalnes library
// it is not:
//
//   close()  -> forcedClose = true; if (ws) ws.close();     <- ws is NULL in backoff
//   onclose  -> ws = null; setTimeout(-> self.open(true), reconnectInterval)
//   open()   -> ws = new WebSocket(...)                     <- never read forcedClose
//
// So a close() landing between reconnect attempts closed nothing and cancelled
// nothing, and the armed timer went on to open a real WebSocket for an instance
// its owner had already discarded and silenced — unownable, unclosable, and (for
// /ws/v1/machine/snapshot) fed ~15 Hz by a live reaprime subscription for ever.
//
// It is reachable on this exact ordering: the skin opens the snapshot
// socket while no machine is connected, reaprime answers {"error":"No machine
// connected"} and CLOSES, the RWS drops into its ~3 s backoff, the machine powers
// on, the /ws/v1/devices edge fires onLinkUp -> resyncMachineSockets() -> replace()
// lands mid-backoff -> orphan.
//
// test/socket-slot.test.mjs cannot catch this: its fake socket's close() is
// authoritative and synchronous. These tests therefore drive the REAL vendored
// library, exactly as index.html loads it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { createSocketSlot, silenceSocket, RECONNECT_POLICY } from '../src/modules/socket-slot.js';

const WS_URL = 'ws://localhost:8080/ws/v1/machine/snapshot';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Every underlying WebSocket the library ever constructs, in order. The leak is
// literally "this array grows when it must not".
const opened = [];

class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    constructor(url) {
        this.url = url;
        this.readyState = FakeWebSocket.CONNECTING;
        opened.push(this);
    }

    close(code, reason) {
        if (this.readyState === FakeWebSocket.CLOSED) return; // idempotent, like the real thing
        this.readyState = FakeWebSocket.CLOSED;
        this.onclose?.({ code: code ?? 1000, reason: reason ?? '', wasClean: true });
    }

    // --- test-side drivers (the "server") ---
    serverAccept() {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.({});
    }

    /** reaprime's no-machine contract: an error frame, then a close. */
    serverClose() {
        this.readyState = FakeWebSocket.CLOSED;
        this.onclose?.({ code: 1000, reason: 'No machine connected', wasClean: true });
    }
}

// Minimal browser surface the UMD needs: it bails unless 'WebSocket' in window,
// and each instance uses a detached <div> as its event target.
globalThis.WebSocket = FakeWebSocket;
globalThis.window = globalThis;
globalThis.document = {
    createElement: () => {
        const listeners = {};
        return {
            addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
            removeEventListener: () => {},
            dispatchEvent: (event) => { (listeners[event.type] || []).forEach((fn) => fn(event)); return true; },
        };
    },
    createEvent: () => ({ initCustomEvent(type) { this.type = type; } }),
};

// Load the vendored library the way index.html does (UMD -> global).
const source = fs.readFileSync(new URL('../src/modules/reconnecting-websocket.js', import.meta.url), 'utf8');
new Function(source).call(globalThis);
const RWS = globalThis.ReconnectingWebSocket;

/** Sockets constructed since `base`. */
const since = (base) => opened.slice(base);

test('THE LEAK: close() during the reconnect backoff must not open an orphan socket', async () => {
    const base = opened.length;

    const rws = new RWS(WS_URL, [], { reconnectInterval: 20 });
    assert.equal(since(base).length, 1, 'construction opens exactly one socket');

    // No machine connected: reaprime sends the error frame and closes. The library
    // is now BETWEEN attempts — ws === null, a reconnect timer armed.
    since(base)[0].serverClose();
    assert.equal(since(base).length, 1, 'still one — the retry has not fired yet');

    // The machine appears. app.js resyncs, so socket-slot silences this instance
    // and closes it — mid-backoff, with no underlying socket to close.
    silenceSocket(rws);
    rws.close();

    await sleep(120); // let the armed reconnect timer fire (and be refused)

    assert.equal(
        since(base).length,
        1,
        'a closed ReconnectingWebSocket must never construct another WebSocket'
    );
    assert.equal(rws.readyState, FakeWebSocket.CLOSED, 'and it must report itself CLOSED, not CONNECTING');
});

test('close() on a LIVE socket closes it and does not reconnect', async () => {
    const base = opened.length;

    const rws = new RWS(WS_URL, [], { reconnectInterval: 20 });
    since(base)[0].serverAccept();
    assert.equal(rws.readyState, FakeWebSocket.OPEN);

    rws.close();

    assert.equal(since(base)[0].readyState, FakeWebSocket.CLOSED);
    await sleep(120);
    assert.equal(since(base).length, 1, 'a forced close must not be followed by a retry');
    assert.equal(rws.readyState, FakeWebSocket.CLOSED);
});

test('REGRESSION GUARD: a socket the SERVER closes still heals itself', async () => {
    // The whole point of the library. The forcedClose guard must only refuse a
    // close WE asked for — an unexpected close must still be retried, or the skin
    // stops recovering from a reaprime restart.
    const base = opened.length;

    const rws = new RWS(WS_URL, [], { reconnectInterval: 20 });
    since(base)[0].serverAccept();
    since(base)[0].serverClose();

    await sleep(120);

    assert.ok(since(base).length >= 2, 'an unexpected close must be retried');

    rws.close();
});

test('END TO END: a resync landing in the backoff leaves exactly ONE live socket', async () => {
    // The precise real-world sequence, through the real library and the real slot.
    const base = opened.length;
    const slot = createSocketSlot('machine snapshot');

    // Skin boots with the machine OFF -> reaprime closes the snapshot socket ->
    // the RWS drops into its reconnect backoff.
    const first = slot.replace(() => new RWS(WS_URL, [], { reconnectInterval: 20 }));
    since(base)[0].serverClose();

    // Machine powered on -> /ws/v1/devices edge -> onLinkUp -> resyncMachineSockets().
    const second = slot.replace(() => new RWS(WS_URL, [], { reconnectInterval: 20 }));
    opened[opened.length - 1].serverAccept();

    await sleep(120); // the discarded instance's reconnect timer comes due here

    const live = since(base).filter((socket) => socket.readyState === FakeWebSocket.OPEN);
    assert.equal(live.length, 1, 'the discarded RWS must not open a socket nobody owns');
    assert.equal(since(base).length, 2, 'exactly two underlying sockets: the dead one and the live one');
    assert.equal(slot.current(), second);
    assert.notEqual(first, second);
    assert.equal(first.readyState, FakeWebSocket.CLOSED);

    second.close();
});

// --- backoff policy: jitter + stableAfterMs (deterministic: timers and clock are driven by hand) ---

/** Drop the current underlying socket and return the reconnect delay the library armed, plus a trigger for it. */
function dropAndCapture() {
    const sock = opened[opened.length - 1];
    const realSetTimeout = globalThis.setTimeout;
    let armed = null;
    globalThis.setTimeout = (fn, ms) => { armed = { fn, ms }; return 0; };
    try { sock.serverClose(); } finally { globalThis.setTimeout = realSetTimeout; }
    assert.ok(armed, 'a reconnect timer must be armed');
    return { delay: armed.ms, fire: armed.fn };
}

function withStubs({ random, now }, fn) {
    const realRandom = Math.random;
    const realNow = Date.now;
    if (random !== undefined) Math.random = () => random;
    if (now) Date.now = now;
    try { return fn(); } finally { Math.random = realRandom; Date.now = realNow; }
}

test('defaults (no new options) back off exactly as before and reset on open', () => {
    const rws = new RWS(WS_URL, [], { reconnectInterval: 1000 });
    let drop = dropAndCapture();
    assert.equal(drop.delay, 1000);
    drop.fire();
    drop = dropAndCapture(); // reconnect never opened
    assert.equal(drop.delay, 1500);
    drop.fire();
    opened[opened.length - 1].serverAccept(); // legacy: open resets the counter...
    drop = dropAndCapture(); // ...even for a socket dropped immediately
    assert.equal(drop.delay, 1000);
    rws.close();
});

test('reconnectJitter only shortens the delay, never lengthens it', () => {
    const rws = new RWS(WS_URL, [], { reconnectInterval: 1000, reconnectJitter: 0.3 });
    const none = withStubs({ random: 0 }, () => dropAndCapture());
    assert.equal(none.delay, 1000, 'random 0 -> un-jittered delay');
    none.fire();
    const most = withStubs({ random: 0.999 }, () => dropAndCapture());
    assert.ok(most.delay <= 1500 && most.delay >= 1500 * 0.7 - 1e-9, `jittered ${most.delay} within [1050, 1500]`);
    rws.close();
});

test('stableAfterMs: a flapping socket keeps backing off, a stable one resets', () => {
    let clock = 1_000_000;
    const now = () => clock;
    const rws = new RWS(WS_URL, [], { reconnectInterval: 1000, stableAfterMs: 5000 });
    withStubs({ now }, () => {
        opened[opened.length - 1].serverAccept();
        clock += 100; // dropped after 100 ms
        let drop = dropAndCapture();
        assert.equal(drop.delay, 1000);
        drop.fire();
        opened[opened.length - 1].serverAccept();
        clock += 100;
        drop = dropAndCapture();
        assert.equal(drop.delay, 1500, 'open->close under stableAfterMs must not reset the counter');
        drop.fire();
        opened[opened.length - 1].serverAccept();
        clock += 100;
        drop = dropAndCapture();
        assert.equal(drop.delay, 2250);
        drop.fire();
        opened[opened.length - 1].serverAccept();
        clock += 6000; // stayed up long enough
        drop = dropAndCapture();
        assert.equal(drop.delay, 1000, 'a stable open resets the delay');
    });
    rws.close();
});

test('RECONNECT_POLICY: classes use the library option names and cap the critical wait at 10 s', () => {
    for (const cls of Object.values(RECONNECT_POLICY)) {
        assert.deepEqual(Object.keys(cls).sort(), ['maxReconnectInterval', 'reconnectDecay', 'reconnectInterval', 'reconnectJitter', 'stableAfterMs']);
    }
    assert.equal(RECONNECT_POLICY.critical.maxReconnectInterval, 10000);
    assert.equal(RECONNECT_POLICY.standard.maxReconnectInterval, 30000);
    assert.equal(RECONNECT_POLICY.background.reconnectInterval, 5000);
    assert.equal(RECONNECT_POLICY.background.maxReconnectInterval, 30000, 'no socket recovers slower than the vendored 30 s default cap');
});

test('api.js: every ReconnectingWebSocket takes a RECONNECT_POLICY class; the dead reload block is gone', () => {
    const api = fs.readFileSync(new URL('../src/modules/api.js', import.meta.url), 'utf8');
    const starts = [...api.matchAll(/new ReconnectingWebSocket\(/g)];
    assert.ok(starts.length >= 14);
    for (const m of starts) {
        assert.match(api.slice(m.index, m.index + 400), /\.\.\.RECONNECT_POLICY\.(critical|standard|background)/);
    }
    assert.ok(!api.includes('reloading now'));
});
