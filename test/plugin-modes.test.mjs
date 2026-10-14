import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pluginOptionCapacity, tileHasBuiltinOption, planTileModes, createCallQueue, clampModeValue, stepModeValue, formatModeValue, sanitizeEdits, effectivePresets, withPresetEdit, presetMenuModel } from '../src/modules/plugin-modes.js';

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

test('planTileModes: steam and flush have no built-in option in the row, so they take three plugin options', () => {
    const plan = planTileModes([
        mode('a', 'steam', 'x'), mode('a', 'steam', 'y'), mode('a', 'steam', 'z'), mode('b', 'steam', 'w'),
        mode('a', 'dose', 'x'), mode('a', 'dose', 'y'), mode('a', 'dose', 'z'),
    ]);
    assert.deepEqual(plan.steam.map(e => e.surface.id), ['x', 'y', 'z']);
    assert.deepEqual(plan.dose.map(e => e.surface.id), ['x', 'y']);
    assert.equal(pluginOptionCapacity('steam'), 3);
    assert.equal(pluginOptionCapacity('temperature'), 2);
    assert.equal(tileHasBuiltinOption('steam'), false);
    assert.equal(tileHasBuiltinOption('flush'), false);
    assert.equal(pluginOptionCapacity('flush'), 3);
    assert.equal(tileHasBuiltinOption('hotwater'), false);
    assert.equal(pluginOptionCapacity('hotwater'), 3);
    assert.equal(tileHasBuiltinOption('drink'), true);
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
    assert.equal(await first, null);
    assert.equal(await second, null);
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
    assert.equal(await b, null);               // c replaced b
    h.gates[0].resolve();
    assert.equal(await a, null);               // sent, but c is waiting: a stale answer
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

const pct = { min: -20, max: 20, step: 1, decimals: 0, unit: '%' };

test('mode values: clamp, step without float noise, and format with a sign only when negative is possible', () => {
    assert.equal(clampModeValue(pct, 99), 20);
    assert.equal(clampModeValue(pct, -99), -20);
    assert.equal(clampModeValue(pct, 2.6), 3);
    assert.equal(stepModeValue({ ...pct, decimals: 1, step: 0.1 }, 0.2, 1), 0.3);
    assert.equal(stepModeValue(pct, 20, 1), 20);
    assert.equal(stepModeValue(pct, -20, -1), -20);
    assert.equal(formatModeValue(pct, 5), '+5%');
    assert.equal(formatModeValue(pct, 0), '0%');
    assert.equal(formatModeValue(pct, -0.3), '0%');
    assert.equal(formatModeValue(pct, -7), '-7%');
    assert.equal(formatModeValue({ min: 0, max: 60, step: 1, decimals: 0, unit: 's' }, 12), '12s');
    assert.equal(formatModeValue({ min: 0, max: 5, step: 0.5, decimals: 1 }, 2), '2.0');
});

test('call queue: a finished job resolves null while a newer payload is debouncing', async () => {
    const h = harness();
    const a = h.queue.request('t', { percent: 1 }, { immediate: true });
    await h.tick();
    const b = h.queue.request('t', { percent: 2 }); // debounced, timer not fired
    h.gates[0].resolve();
    assert.equal(await a, null);
    assert.equal(h.sent.length, 1);
    h.fire(); await h.tick();
    assert.equal(h.sent.length, 2);
    h.gates[1].resolve();
    assert.equal(await b, true);
});

test('call queue: a failed send stays false even with a newer payload waiting', async () => {
    const h = harness();
    const a = h.queue.request('t', 1, { immediate: true });
    await h.tick();
    h.queue.request('t', 2, { immediate: true });
    h.gates[0].reject(new Error('boom'));
    assert.equal(await a, false);
});

test('call queue: busy(key) covers debounce, in flight and the newest waiting', async () => {
    const h = harness();
    assert.equal(h.queue.busy('t'), false);
    const a = h.queue.request('t', 1);
    assert.equal(h.queue.busy('t'), true);      // debouncing
    assert.equal(h.queue.busy('other'), false);
    h.fire(); await h.tick();
    assert.equal(h.queue.busy('t'), true);      // in flight
    const b = h.queue.request('t', 2, { immediate: true });
    h.gates[0].resolve();
    assert.equal(await a, null);
    assert.equal(h.queue.busy('t'), true);      // b now in flight
    await h.tick();
    h.gates[1].resolve();
    assert.equal(await b, true);
    await h.tick();
    assert.equal(h.queue.busy('t'), false);
});

const withPresets = { ...pct, presets: [-5, -2, 2, 5] };
const e = (base, value) => ({ base, value });

test('preset edits: the user value wins per slot, bad edits are ignored, null clears', () => {
    assert.deepEqual(sanitizeEdits(withPresets, [null, e(-2, 3), 'x', e(5, 99), 7]), [null, e(-2, 3), null, e(5, 20)]);
    assert.deepEqual(sanitizeEdits(withPresets, 'junk'), [null, null, null, null]);
    assert.deepEqual(sanitizeEdits(withPresets, [{ base: -5, value: NaN }, { value: 1 }, 5, { base: 2 }]), [null, null, null, null]);
    assert.deepEqual(effectivePresets(withPresets, [null, e(-2, 3)]), [-5, 3, 2, 5]);
    const edited = withPresetEdit(withPresets, null, 2, 8);
    assert.deepEqual(edited, [null, null, e(2, 8), null]);
    assert.deepEqual(withPresetEdit(withPresets, edited, 2, null), [null, null, null, null]);
    assert.deepEqual(withPresetEdit(withPresets, edited, 9, 1), edited);
});

test('preset edits follow the plugin preset they were made on, not the slot', () => {
    const edits = [e(-5, 9), null, null, null];
    assert.deepEqual(effectivePresets(withPresets, edits), [9, -2, 2, 5]);
    // the plugin reorders or recalculates: the edit no longer matches, so it is dropped
    assert.deepEqual(effectivePresets({ ...withPresets, presets: [5, 2, -2, -5] }, edits), [5, 2, -2, -5]);
    assert.deepEqual(effectivePresets({ ...withPresets, presets: [-4, -2, 2, 5] }, edits), [-4, -2, 2, 5]);
    // fewer presets: nothing out of range is kept
    assert.deepEqual(sanitizeEdits({ ...withPresets, presets: [-5, -2] }, [e(-5, 9), null, null, e(5, 1)]), [e(-5, 9), null]);
});

test('presetsEditable false: the plugin presets always show, edits are kept for later', () => {
    const locked = { ...withPresets, presetsEditable: false };
    const edits = [e(-5, 9), null, null, null];
    assert.deepEqual(effectivePresets(locked, edits), [-5, -2, 2, 5]);
    assert.deepEqual(withPresetEdit(locked, edits, 1, 3)[0], e(-5, 9)); // stored edit survives
    assert.deepEqual(effectivePresets(withPresets, edits), [9, -2, 2, 5]); // unlocked again
});

test('preset menu: built-in items, revert only after an edit, plugin items last, no editing when locked', () => {
    const ids = model => model.map(m => m.id);
    const plain = presetMenuModel(withPresets, 1, null, 4);
    assert.deepEqual(ids(plain), ['apply', 'enter', 'save', 'revert']);
    assert.equal(plain.find(m => m.id === 'revert').disabled, true);
    assert.equal(plain.find(m => m.id === 'save').value, 4);
    const edited = presetMenuModel({ ...withPresets, menu: [{ label: 'Reset', value: 0 }] }, 1, [null, e(-2, 9)], 4);
    assert.deepEqual(ids(edited), ['apply', 'enter', 'save', 'revert', 'menu']);
    assert.equal(edited[0].value, 9);                            // the edit is what applies
    assert.equal(edited.find(m => m.id === 'revert').value, -2); // revert goes to the plugin's own
    assert.equal(edited.find(m => m.id === 'revert').disabled, false);
    const locked = presetMenuModel({ ...withPresets, presetsEditable: false, menu: [{ label: 'Reset', value: 0 }] }, 0, [e(-5, 9)], NaN);
    assert.deepEqual(ids(locked), ['apply', 'menu']);
    assert.equal(locked[0].value, -5);                           // not the old edit
    assert.equal(presetMenuModel({ ...withPresets, presetsEditable: false }, 0, null, 0).length, 1);
    assert.equal(presetMenuModel(withPresets, 0, null, NaN).find(m => m.id === 'save').disabled, true);
});
