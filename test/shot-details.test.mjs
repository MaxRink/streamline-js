import test from 'node:test';
import assert from 'node:assert/strict';
import { shotDetailRows, pickDialInRecommendation, dialInRecommendationRows, E64_PLUGIN_ID } from '../src/modules/shot-details.js';

const shot = context => ({ id: 's1', workflow: { context } });

test('shot details: coffee, grinder, setting and the E64 last grind from the workflow snapshot', () => {
    assert.deepEqual(shotDetailRows(shot({
        coffeeRoaster: 'Square Mile', coffeeName: 'Red Brick',
        grinderModel: 'Mahlkönig E64 WS', grinderBurrs: '64 mm steel', grinderSetting: '83',
        extras: { [E64_PLUGIN_ID]: { displayedSetting: '83', unit: 'µm', lastGrind: { completedAt: 'x', targetWeightGr: 18, resultWeightGr: 18.14, motorRunTimeMs: 6240, mode: 'GbW' } } },
    })), [
        { label: 'Coffee', value: 'Square Mile · Red Brick' },
        { label: 'Grinder', value: 'Mahlkönig E64 WS · 64 mm steel' },
        { label: 'Grind setting', value: '83' },
        { label: 'Last grind', value: '18.1 g / 18 g · 6.2 s · GbW' },
    ]);
});

test('shot details: the grinder display shows only where it differs from the recorded setting', () => {
    const rows = shotDetailRows(shot({ grinderSetting: '12', extras: { [E64_PLUGIN_ID]: { displayedSetting: '83', unit: 'µm', lastGrind: { resultWeightGr: 17.5 } } } }));
    assert.deepEqual(rows, [
        { label: 'Grind setting', value: '12' },
        { label: 'Grinder display', value: '83 µm' },
        { label: 'Last grind', value: '17.5 g' },
    ]);
});

test('shot details: nothing recorded is no rows, never "undefined"', () => {
    for (const s of [shot({}), {}, null, shot({ coffeeName: '  ', extras: { [E64_PLUGIN_ID]: { lastGrind: {} } } })]) {
        assert.deepEqual(shotDetailRows(s), [], JSON.stringify(s));
    }
    assert.deepEqual(shotDetailRows({ workflow: { grinderData: { setting: 4.5 } } }), [{ label: 'Grind setting', value: '4.5' }]);
});

// The stored record dial-in 0.8.0 keeps per shot (cleanRecommendation in its plugin.js).
const stored = {
    computedAt: '2026-11-23T08:01:00.000Z', trigger: 'shotStored', status: 'suggestion', direction: 'finer',
    currentSetting: '500', proposedSetting: 495, proposedPreset: null, settingUnit: 'µm',
    lastShotTimeSec: 23, targetTimeSec: 28, grinderId: 'g1',
    message: 'Next shot: grind 5 µm finer (500 → 495); last shot 23 s vs target 28 s.',
};

test('dial-in 0.8.0: shotId, shotIds and latest answers are all read for the shot', () => {
    assert.equal(pickDialInRecommendation({ shotId: 's1', recommendation: stored }, 's1'), stored);
    assert.equal(pickDialInRecommendation({ shotId: 's1', recommendation: null }, 's1'), null, 'no recommendation kept for this shot');
    assert.equal(pickDialInRecommendation({ shotId: 's2', recommendation: stored }, 's1'), null, 'an answer for another shot');
    assert.equal(pickDialInRecommendation({ recommendations: { s0: null, s1: stored } }, 's1'), stored);
    assert.equal(pickDialInRecommendation({ recommendations: { s1: null } }, 's1'), null);
    assert.equal(pickDialInRecommendation({ latest: [{ shotId: 's0', recommendation: { ...stored, status: 'abstain' } }, { shotId: 's1', recommendation: stored }] }, 's1'), stored);
    assert.equal(pickDialInRecommendation([{ shotId: 's1', ...stored }], 's1').status, 'suggestion');
    assert.equal(pickDialInRecommendation(stored, 's1'), stored, 'a bare entry');
    for (const body of [null, {}, { latest: [] }, { error: 'shotId is invalid' }, 'html']) assert.equal(pickDialInRecommendation(body, 's1'), null);
});

test('dial-in rows: the next grind, then the plugin\'s own message', () => {
    assert.deepEqual(dialInRecommendationRows(stored), [
        { label: 'Suggested grind', value: '495 µm (finer)', translate: false },
        { label: '', value: stored.message },
    ]);
    assert.deepEqual(dialInRecommendationRows({ ...stored, proposedSetting: null, proposedPreset: 'B', message: 'Next shot: grind finer, preset B.' }), [
        { label: 'Suggested grind', value: 'B (finer)', translate: false },
        { label: '', value: 'Next shot: grind finer, preset B.' },
    ]);
    assert.deepEqual(dialInRecommendationRows({ status: 'abstain', message: 'No grind change suggested yet: more feedback is needed.' }), [
        { label: 'Suggested grind', value: 'No recommendation', translate: true },
        { label: '', value: 'No grind change suggested yet: more feedback is needed.' },
    ]);
    assert.deepEqual(dialInRecommendationRows({ status: 'suggestion', message: 'Balanced: keep the setting.' }), [
        { label: 'Suggested grind', value: 'Balanced: keep the setting.', translate: false },
    ]);
    assert.deepEqual(dialInRecommendationRows({ status: 'recommendation', grinderSetting: '12', settingUnit: 'clicks', warnings: ['History scan is bounded'] }), [
        { label: 'Recommended grind', value: '12 clicks', translate: false },
        { label: '', value: 'History scan is bounded' },
    ]);
    assert.deepEqual(dialInRecommendationRows({ status: 'suggestion' }), []);
    assert.deepEqual(dialInRecommendationRows(null), []);
});

test('shot details: the advice the shot was brewed with, from the workflow snapshot', () => {
    assert.deepEqual(shotDetailRows(shot({ extras: { 'assisted-dialin.reaplugin': { recommendation: { afterShotId: 's0', ...stored } } } })), [
        { label: 'Advice before this shot', value: stored.message },
    ]);
});
