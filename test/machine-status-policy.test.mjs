import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveStatusStateKey, isActionTailSubstate } from '../src/modules/machine-status-policy.js';

// Recorded [status, substate] frames. app.js builds the status from the MachineState
// and never appends the filler `idle` substate, so the substate arrives separately.
const espresso = [
    ['Espresso', 'idle'], ['Espresso', 'preparingForShot'], ['Espresso', 'preinfusion'],
    ['Espresso', 'pouring'], ['Espresso', 'pouringDone'], ['Espresso', 'idle'],
];
const steam = [['Steam', 'idle'], ['Steam', 'pouring'], ['Steam', 'puffing'], ['Steam', 'idle']];

test('no frame of an action state resolves to idle', () => {
    for (const [status, substate] of [...espresso, ...steam]) {
        assert.notEqual(resolveStatusStateKey(status, substate), 'idle', `${status}/${substate}`);
    }
});

test('action substates still resolve from the substate', () => {
    assert.equal(resolveStatusStateKey('Espresso', 'preinfusion'), 'preinfusion');
    assert.equal(resolveStatusStateKey('Espresso', 'pouring'), 'pouring');
    assert.equal(resolveStatusStateKey('Steam', 'pouring'), 'pouring');
});

test('state-level keys never resolve from the substate', () => {
    for (const substate of ['idle', 'sleeping', 'disconnected', 'error', 'heating']) {
        assert.equal(resolveStatusStateKey('Espresso', substate), '', substate);
    }
});

test('state-level keys still resolve from the status', () => {
    assert.equal(resolveStatusStateKey('Idle', 'idle'), 'idle');
    assert.equal(resolveStatusStateKey('Sleeping', ''), 'sleeping');
    assert.equal(resolveStatusStateKey('Disconnected', undefined), 'disconnected');
    assert.equal(resolveStatusStateKey('Heating 12s', 'idle'), 'heating');
    assert.equal(resolveStatusStateKey('Error', 'idle'), 'error');
});

test('the tail predicate is true for pouringDone and puffing only', () => {
    assert.equal(isActionTailSubstate('pouringDone'), true);
    assert.equal(isActionTailSubstate('puffing'), true);
    for (const substate of ['pouring', 'idle', 'pausedSteam', 'preinfusion', undefined]) {
        assert.equal(isActionTailSubstate(substate), false, String(substate));
    }
});
