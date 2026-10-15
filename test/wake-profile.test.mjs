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
