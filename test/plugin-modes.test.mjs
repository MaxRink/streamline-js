import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planTileModes, createCallQueue } from '../src/modules/plugin-modes.js';

const mode = (plugin, tile, id = 'm') => ({ plugin: { id: plugin }, surface: { id, kind: 'tile-mode', tile } });

test('planTileModes: two plugin options per tile, the first plugins win, other kinds ignored', () => {
    const plan = planTileModes([
        mode('a', 'temperature'), mode('b', 'temperature'), mode('c', 'temperature'),
        mode('a', 'dose'),
        { plugin: { id: 'a' }, surface: { id: 'l', kind: 'tile-line', tile: 'dose' } },
    ]);
    assert.deepEqual(plan.temperature.map(e => e.plugin.id), ['a', 'b']);
    assert.deepEqual(plan.dose.map(e => e.plugin.id), ['a']);
    assert.equal(plan.grind, undefined);
});

function harness() {
    const timers = [];
    const sent = [];
    const gates = [];
    const queue = createCallQueue({
        delayMs: 300,
        setTimer: fn => { timers.push(fn); return timers.length; },
        clearTimer: id => { timers[id - 1] = null; },
        send: (key, payload) => new Promise((resolve, reject) => { sent.push([key, payload]); gates.push({ resolve, reject }); }),
    });
    const fire = () => timers.forEach((fn, i) => { if (fn) { timers[i] = null; fn(); } });
    const tick = () => new Promise(r => setImmediate(r));
    return { queue, sent, gates, fire, tick };
}

test('call queue: a burst is debounced to the newest payload', async () => {
    const h = harness();
    const first = h.queue.request('t', { percent: 1 });
    const second = h.queue.request('t', { percent: 2 });
    const third = h.queue.request('t', { percent: 3 });
    assert.equal(await first, false);
    assert.equal(await second, false);
    h.fire(); await h.tick();
    assert.deepEqual(h.sent, [['t', { percent: 3 }]]);
    h.gates[0].resolve(); 
    assert.equal(await third, true);
});

test('call queue: one in flight per key, the newest waits for it, then goes', async () => {
    const h = harness();
    const a = h.queue.request('t', { percent: 5 }, { immediate: true });
    await h.tick();
    const b = h.queue.request('t', { percent: 6 }, { immediate: true });
    const c = h.queue.request('t', { percent: 7 }, { immediate: true });
    await h.tick();
    assert.equal(h.sent.length, 1);            // b and c wait for a
    assert.equal(await b, false);              // c replaced b
    h.gates[0].resolve();
    assert.equal(await a, true);
    await h.tick();
    assert.deepEqual(h.sent.map(s => s[1]), [{ percent: 5 }, { percent: 7 }]);
    h.gates[1].resolve();
    assert.equal(await c, true);
});

test('call queue: keys are independent, and a failed send resolves false without blocking', async () => {
    const h = harness();
    const a = h.queue.request('a', 1, { immediate: true });
    const b = h.queue.request('b', 2, { immediate: true });
    await h.tick();
    assert.equal(h.sent.length, 2);
    h.gates[0].reject(new Error('boom'));
    assert.equal(await a, false);
    h.gates[1].resolve();
    assert.equal(await b, true);
    const again = h.queue.request('a', 3, { immediate: true });
    await h.tick();
    assert.deepEqual(h.sent[2], ['a', 3]);
    h.gates[2].resolve();
    assert.equal(await again, true);
});
