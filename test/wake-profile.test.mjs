// Run: node --test test/wake-profile.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sleepProfileMark, shouldApplyWakeProfile } from '../src/modules/wake-profile.js';

const a = { title: 'Londinium', target_weight: 36, steps: [{ name: 'fill', temperature: 90 }] };
const b = { title: 'Blooming', target_weight: 40, steps: [{ name: 'bloom', temperature: 92 }] };

test('wake profile loads when the profile is unchanged since sleep, even if brew temperature moved', () => {
    const mark = sleepProfileMark({ profile: a });
    assert.equal(shouldApplyWakeProfile(mark, { profile: a }), true);
    assert.equal(shouldApplyWakeProfile(mark, { profile: { ...a, steps: [{ ...a.steps[0], temperature: 94 }] } }), true);
});

test('a profile chosen while asleep is not replaced', () => {
    assert.equal(shouldApplyWakeProfile(sleepProfileMark({ profile: a }), { profile: b }), false);
});

test('no mark or no readable workflow keeps the old behaviour (load it)', () => {
    assert.equal(shouldApplyWakeProfile(null, { profile: b }), true);
    assert.equal(shouldApplyWakeProfile(sleepProfileMark({ profile: a }), {}), true);
    assert.equal(sleepProfileMark(null), null);
});

test('a yield changed while asleep is not a different profile', () => {
    const mark = sleepProfileMark({ profile: a });
    assert.equal(shouldApplyWakeProfile(mark, { profile: { ...a, target_weight: 42 } }), true);
});

test('a sleep mark taken with a 0 limiter matches the live profile reporting null', () => {
    const zero = { ...a, steps: [{ ...a.steps[0], limiter: { value: 0, range: 0.6 } }] };
    const none = { ...a, steps: [{ ...a.steps[0], limiter: null }] };
    assert.equal(shouldApplyWakeProfile(sleepProfileMark({ profile: zero }), { profile: none }), true);
});
