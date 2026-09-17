import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queryAutoSteamCapability, manualSteamMode, steamModeCycle } from '../src/modules/auto-steam-capability.js';

const compatible = {
    id: 'calibrated-steam.reaplugin',
    loaded: true,
    api: [
        { id: 'status', type: 'http' },
        { id: 'calculate', type: 'http' },
    ],
};

test('capability query requires a loaded plugin with both HTTP endpoints', () => {
    assert.equal(queryAutoSteamCapability([compatible]).available, true);
    assert.equal(queryAutoSteamCapability([{ ...compatible, loaded: false }]).available, false);
    assert.equal(queryAutoSteamCapability([{ ...compatible, api: compatible.api.slice(1) }]).available, false);
    assert.equal(queryAutoSteamCapability([{ ...compatible, api: [{ id: 'status', type: 'websocket' }, compatible.api[1]] }]).available, false);
    assert.equal(queryAutoSteamCapability(null).available, false);
});

test('the stock mode cycle is unchanged without the capability', () => {
    assert.deepEqual(steamModeCycle(), ['time', 'flow']);
    assert.deepEqual(steamModeCycle({ milkAvailable: true }), ['temperature', 'flow']);
    assert.equal(manualSteamMode(), 'time');
    assert.equal(manualSteamMode({ milkAvailable: true }), 'temperature');
});

test('Auto is added only by the capability query result', () => {
    assert.deepEqual(steamModeCycle({ autoAvailable: queryAutoSteamCapability([compatible]).available }), ['time', 'auto', 'flow']);
    assert.deepEqual(steamModeCycle({ autoAvailable: true, milkAvailable: true }), ['temperature', 'auto', 'flow']);
});
