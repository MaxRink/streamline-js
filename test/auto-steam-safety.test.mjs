import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampAutoSteamSettings } from '../src/modules/auto-steam-safety.js';

test('machine-bound duration and flow are clamped at the final write boundary', () => {
    assert.deepEqual(clampAutoSteamSettings({ duration: 999, flow: 9, targetTemperature: 150, stopAtTemperature: 0 }),
        { duration: 255, flow: 2.5, targetTemperature: 150, stopAtTemperature: 0 });
    assert.deepEqual(clampAutoSteamSettings({ duration: -4, flow: -1, targetTemperature: 0 }),
        { duration: 0, flow: 0, targetTemperature: 0 });
    assert.equal(clampAutoSteamSettings({ duration: 12.6, flow: 1.234, targetTemperature: 145 }).duration, 13);
});

test('non-finite values and unsafe temperatures are rejected', () => {
    for (const value of [
        { duration: NaN, flow: 1, targetTemperature: 150 },
        { duration: 30, flow: Infinity, targetTemperature: 150 },
        { duration: 30, flow: 1, targetTemperature: 166 },
        { duration: 30, flow: 1, targetTemperature: 150, stopAtTemperature: 81 },
    ]) assert.throws(() => clampAutoSteamSettings(value), /Invalid Auto steam/);
});
