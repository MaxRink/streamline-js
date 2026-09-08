// Show-once policy for the Sensor Calibration danger warning modal.
//
// The bug: the render path used to gate re-opening the modal on "has the
// user acknowledged it?" alone. That page re-renders on every keystroke,
// capture, apply/restore, and the initial calibration load completing --
// each render rebuilds the <dialog> from scratch (closed) -- so the modal
// reopened on every one of those renders until the user clicked Ok, i.e. it
// reappeared repeatedly instead of showing once per visit.
//
// settings.js touches the DOM at import time, so -- same pattern as
// profile-editor-cards.test.mjs before it -- the pure state transition is
// lifted out of the real source with a slice, not hand-copied, so this
// can't silently drift from what actually ships.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const source = readFileSync(new URL('../src/settings/settings.js', import.meta.url), 'utf8');

const start = source.indexOf('// ─── sensor-cal warning visit policy');
const end = source.indexOf('// ─── end sensor-cal warning visit policy');
assert.ok(start !== -1 && end !== -1 && end > start, 'sensor-cal warning policy block not found in settings.js');
const body = source.slice(start, end);

const { sensorCalWarningNextState } = new Function(`${body}
    return { sensorCalWarningNextState };`)();

const FRESH = { shown: false, ack: false };

test('enter-page: the first render of a visit opens the warning', () => {
    const { state, open } = sensorCalWarningNextState(FRESH, 'render');
    assert.equal(open, true);
    assert.deepEqual(state, { shown: true, ack: false });
});

test('re-render: further renders before dismissal do not reopen it', () => {
    let state = FRESH;
    ({ state } = sensorCalWarningNextState(state, 'render')); // enter-page
    for (const cause of ['render', 'render', 'render']) { // load completing, an edit, capture/apply/restore
        const result = sensorCalWarningNextState(state, cause);
        assert.equal(result.open, false, 'a later render must not reopen the warning');
        state = result.state;
    }
    assert.deepEqual(state, { shown: true, ack: false });
});

test('dismiss (Ok): acknowledging does not reopen it, and later renders still do not', () => {
    let state = sensorCalWarningNextState(FRESH, 'render').state; // shown
    let result = sensorCalWarningNextState(state, 'ack');
    assert.equal(result.open, false);
    assert.deepEqual(result.state, { shown: true, ack: true });

    result = sensorCalWarningNextState(result.state, 'render'); // e.g. a later Apply
    assert.equal(result.open, false);
    assert.deepEqual(result.state, { shown: true, ack: true });
});

test('leave-page: navigating to another category re-arms both flags', () => {
    let state = sensorCalWarningNextState(FRESH, 'render').state;
    state = sensorCalWarningNextState(state, 'ack').state;
    const result = sensorCalWarningNextState(state, 'leave');
    assert.equal(result.open, false);
    assert.deepEqual(result.state, { shown: false, ack: false });
});

test('re-enter: coming back after leaving shows the warning again', () => {
    let state = sensorCalWarningNextState(FRESH, 'render').state;
    state = sensorCalWarningNextState(state, 'ack').state;
    state = sensorCalWarningNextState(state, 'leave').state;

    const result = sensorCalWarningNextState(state, 'render');
    assert.equal(result.open, true);
    assert.deepEqual(result.state, { shown: true, ack: false });
});

test('leaving without ever acknowledging still re-arms cleanly (Cancel path)', () => {
    let state = sensorCalWarningNextState(FRESH, 'render').state; // shown, never acked
    const result = sensorCalWarningNextState(state, 'leave');
    assert.deepEqual(result.state, { shown: false, ack: false });
});

test('an unknown event is a no-op, never opening the warning', () => {
    const result = sensorCalWarningNextState(FRESH, 'bogus');
    assert.equal(result.open, false);
    assert.deepEqual(result.state, FRESH);
});
