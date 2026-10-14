import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shiftedTemperatures, profileAtBrewTemp } from '../src/modules/brew-temp.js';

test('shiftedTemperatures keeps every step at its distance from the first', () => {
    assert.deepEqual(shiftedTemperatures([94, 90, 88], 92), [92, 88, 86]);
    assert.deepEqual(shiftedTemperatures([94, 90, 88], 96), [96, 92, 90]);
    assert.deepEqual(shiftedTemperatures([90, 90, 89.5], 93), [93, 93, 92.5]);
    assert.deepEqual(shiftedTemperatures([92, 92, 92], 88), [88, 88, 88]);   // a flat profile stays flat
    assert.deepEqual(shiftedTemperatures([94, 90, 88], 94), [94, 90, 88]);   // no change
});

test('shiftedTemperatures rounds away float noise and takes numeric strings', () => {
    assert.deepEqual(shiftedTemperatures([90.1, 89.7], 92.3), [92.3, 91.9]);
    assert.deepEqual(shiftedTemperatures([94, 90], '92'), [92, 88]);
});

test('shiftedTemperatures gives null when there is no first step to measure from', () => {
    assert.equal(shiftedTemperatures([], 92), null);
    assert.equal(shiftedTemperatures(null, 92), null);
    assert.equal(shiftedTemperatures([undefined, 90], 92), null);
    assert.equal(shiftedTemperatures(['94', 90], 92), null);
    assert.equal(shiftedTemperatures([94, 90], 'x'), null);
});

test('a step without a temperature takes the target', () => {
    assert.deepEqual(shiftedTemperatures([94, undefined, 88], 92), [92, 92, 86]);
});

test('profileAtBrewTemp returns a shifted copy and never mutates the profile', () => {
    const profile = { title: 'P', steps: [{ name: 'a', temperature: 94 }, { name: 'b', temperature: 90 }, { name: 'c', temperature: 88 }] };
    const out = profileAtBrewTemp(profile, 92);
    assert.deepEqual(out.steps.map(s => s.temperature), [92, 88, 86]);
    assert.deepEqual(out.steps.map(s => s.name), ['a', 'b', 'c']);
    assert.deepEqual(profile.steps.map(s => s.temperature), [94, 90, 88]);
    assert.notEqual(out.steps[0], profile.steps[0]);
});

test('profileAtBrewTemp falls back to one temperature when the first step is unusable, and ignores junk', () => {
    const bad = { steps: [{ name: 'a' }, { name: 'b', temperature: 90 }] };
    assert.deepEqual(profileAtBrewTemp(bad, 92).steps.map(s => s.temperature), [92, 92]);
    const noSteps = { title: 'x' };
    assert.equal(profileAtBrewTemp(noSteps, 92), noSteps);
    const profile = { steps: [{ temperature: 94 }] };
    assert.equal(profileAtBrewTemp(profile, 'x'), profile);
});

test('an old flat saved value restores the shape from the original profile', () => {
    // the saved override was 92 (the old tile wrote 92 on every step); the original is 94/90/88
    const original = { steps: [{ temperature: 94 }, { temperature: 90 }, { temperature: 88 }] };
    assert.deepEqual(profileAtBrewTemp(original, 92).steps.map(s => s.temperature), [92, 88, 86]);
});
