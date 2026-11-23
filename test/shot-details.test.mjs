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

test('dial-in: the single answer, a batch list and a batch map are all read for the shot', () => {
    const rec = { status: 'recommendation', grinderSetting: '12', settingUnit: 'clicks' };
    assert.equal(pickDialInRecommendation(rec, 's1'), rec);
    assert.equal(pickDialInRecommendation({ shotId: 's1', ...rec }, 's1').grinderSetting, '12');
    assert.equal(pickDialInRecommendation({ shotId: 's2', ...rec }, 's1'), null, 'an answer for another shot');
    assert.equal(pickDialInRecommendation({ recommendation: rec }, 's1'), rec);
    assert.equal(pickDialInRecommendation({ recommendations: [{ shotId: 's0', status: 'abstain' }, { shotId: 's1', ...rec }] }, 's1').grinderSetting, '12');
    assert.equal(pickDialInRecommendation([{ shotId: 's1', ...rec }], 's1').status, 'recommendation');
    assert.equal(pickDialInRecommendation({ recommendations: { s1: rec } }, 's1'), rec);
    for (const body of [null, {}, { recommendations: [] }, { error: 'x' }, 'html']) assert.equal(pickDialInRecommendation(body, 's1'), null);
});

test('dial-in rows: what to grind next and why, in the plugin\'s words', () => {
    assert.deepEqual(dialInRecommendationRows({ status: 'recommendation', grinderSetting: '12', settingUnit: 'clicks', warnings: ['History scan is bounded'] }), [
        { label: 'Recommended grind', value: '12 clicks', translate: false },
        { label: '', value: 'History scan is bounded' },
    ]);
    assert.deepEqual(dialInRecommendationRows({ status: 'suggestion', proposedSetting: '11.5', direction: 'finer', reason: 'Sour and fast' }), [
        { label: 'Suggested grind', value: '11.5 (finer)', translate: false },
        { label: '', value: 'Sour and fast' },
    ]);
    assert.deepEqual(dialInRecommendationRows({ status: 'abstain', reason: 'No comparable marked-good shot found' }), [
        { label: 'Recommended grind', value: 'No recommendation', translate: true },
        { label: '', value: 'No comparable marked-good shot found' },
    ]);
    assert.deepEqual(dialInRecommendationRows({ status: 'suggestion' }), []);
    assert.deepEqual(dialInRecommendationRows(null), []);
});
