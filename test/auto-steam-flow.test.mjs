import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoSteamFlowSettings, steamAdjustmentControls } from '../src/modules/auto-steam-flow.js';

test('old plugins and single calibration keep a fixed flow', () => {
    assert.deepEqual(autoSteamFlowSettings({ settings: { referenceFlow: 0.4 } }), { adjustable: false, minimum: 0.4, maximum: 0.4, defaultFlow: 0.4 });
    assert.equal(steamAdjustmentControls('auto', { adjustableFlow: false }, 'idle').visible, false);
});
test('multiple calibration exposes only valid measured bounds', () => {
    const flowCalibration = { adjustable: true, mode: 'multiple', minimum: 0.4, maximum: 2.5, defaultFlow: 1 };
    assert.equal(autoSteamFlowSettings({ flowCalibration }).adjustable, true);
    for (const patch of [{ minimum: 0.3 }, { maximum: 2.6 }, { minimum: 2.5 }, { defaultFlow: 3 }]) {
        assert.equal(autoSteamFlowSettings({ flowCalibration: { ...flowCalibration, ...patch } }), null);
    }
});
test('manual modes retain controls; multiple Auto controls respect bounds, machine state and writes', () => {
    const state = { adjustableFlow: true, flow: 0.4, minimumFlow: 0.4, maximumFlow: 2.5, configurationReady: true, busy: false };
    assert.deepEqual(steamAdjustmentControls('auto', state, 'idle'), { visible: true, minusDisabled: true, plusDisabled: false });
    assert.equal(steamAdjustmentControls('auto', { ...state, flow: 2.5 }, 'idle').plusDisabled, true);
    assert.equal(steamAdjustmentControls('auto', state, 'steam').plusDisabled, true);
    assert.equal(steamAdjustmentControls('auto', { ...state, busy: true }, 'idle').plusDisabled, true);
    for (const mode of ['flow', 'time', 'temperature']) {
        assert.deepEqual(steamAdjustmentControls(mode, { ...state, adjustableFlow: false }, 'idle'), { visible: true, minusDisabled: false, plusDisabled: false });
    }
});
