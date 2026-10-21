import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    SAVER_BRIGHTNESS_DEFAULT, SAVER_BRIGHTNESS_KEY, SAVER_BRIGHTNESS_CUSTOM_KEY,
    resolveSaverBrightness, parseSaverBrightnessSetting,
} from '../src/modules/saver-brightness.js';
import { SYNCED_KEYS, hydrate } from '../src/modules/settingsSync.js';

test('saver brightness defaults and storage keys are stable', () => {
    assert.equal(SAVER_BRIGHTNESS_DEFAULT, 10);
    assert.equal(SAVER_BRIGHTNESS_KEY, 'screensaverBrightness');
    assert.equal(SAVER_BRIGHTNESS_CUSTOM_KEY, 'screensaverBrightnessCustom');
});

test('only an explicit custom flag enables a stored level', () => {
    for (const custom of [false, undefined, null, 'true', 'false', 1, {}]) {
        for (const stored of ['0', '100', 'abc', null]) {
            assert.equal(resolveSaverBrightness({ custom, stored }), 10);
        }
    }
});

test('custom zero is screen off, not a missing value', () => {
    assert.equal(resolveSaverBrightness({ custom: true, stored: '0' }), 0);
    assert.equal(resolveSaverBrightness({ custom: true, stored: 0 }), 0);
    assert.equal(resolveSaverBrightness(parseSaverBrightnessSetting('true', '0')), 0);
});

test('custom levels are rounded and clamped to integer percentages', () => {
    for (const [stored, expected] of [['100', 100], ['150', 100], ['-5', 0], ['35.6', 36], [42.2, 42]]) {
        assert.equal(resolveSaverBrightness({ custom: true, stored }), expected);
    }
});

test('absent and garbage custom levels fall back to 10', () => {
    for (const stored of ['', '  ', 'abc', '10abc', undefined, null, NaN, Infinity, -Infinity,
        'NaN', 'Infinity', true, false, [], {}, Symbol('bad'), 10n]) {
        assert.equal(resolveSaverBrightness({ custom: true, stored }), 10);
    }
    for (const input of [undefined, null, false, 'garbage', 10, Symbol('bad')]) {
        assert.equal(resolveSaverBrightness(input), 10);
    }
});

test('raw settings parse to an explicit boolean and normalized numeric level', () => {
    assert.deepEqual(parseSaverBrightnessSetting('true', '0'), { custom: true, stored: 0 });
    assert.deepEqual(parseSaverBrightnessSetting('false', '75'), { custom: false, stored: 75 });
    for (const flag of ['garbage', '', null, undefined, true, 1]) {
        assert.deepEqual(parseSaverBrightnessSetting(flag, 'abc'), { custom: false, stored: 10 });
    }
});

test('every resolved level is a finite integer in 0..100', () => {
    const values = [undefined, null, '', 'abc', NaN, Infinity, {}, Symbol('bad')];
    for (let level = -200; level <= 200; level += 0.5) values.push(level, String(level));
    for (const stored of values) {
        for (const custom of [true, false]) {
            const level = resolveSaverBrightness({ custom, stored });
            assert.ok(Number.isFinite(level) && Number.isInteger(level) && level >= 0 && level <= 100);
        }
    }
});

// Exercise the real API functions without importing its browser-only module graph,
// following display-command-queue.test.mjs's source-extraction pattern.
function brightnessApi(initial = {}, awake = 75) {
    const source = readFileSync(new URL('../src/modules/api.js', import.meta.url), 'utf8');
    const start = source.indexOf('export function isBlackScreenSaver()');
    const end = source.indexOf('export function isWakeLockEnabled()', start);
    assert.ok(start !== -1 && end > start);
    const storage = new Map(Object.entries(initial));
    const sent = [];
    const api = new Function('localStorage', 'resolveSaverBrightness', 'parseSaverBrightnessSetting',
        'SAVER_BRIGHTNESS_KEY', 'SAVER_BRIGHTNESS_CUSTOM_KEY', 'sendDisplayCommand', 'persistLastValue',
        `let lastDisplayState = { requestedBrightness: ${awake} };
         let brightnessBeforeDim = null, lastRestoredBrightness = null;
         const BRIGHTNESS_LAST_VALUE_KEY = 'last-brightness';
         ${source.slice(start, end).replaceAll('export ', '')}
         return { getSaverBrightness, isCustomSaverBrightness, setCustomSaverBrightnessEnabled,
             setSaverBrightness, setBlackScreenSaver, dimDisplay, restoreDisplay, rememberBrightness };`)(
        { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
        resolveSaverBrightness, parseSaverBrightnessSetting, SAVER_BRIGHTNESS_KEY, SAVER_BRIGHTNESS_CUSTOM_KEY,
        command => sent.push(command), () => {},
    );
    return { api, storage, sent };
}

test('API setters persist normalized values; default/custom/black modes stay distinct', () => {
    const { api, storage } = brightnessApi();
    assert.equal(api.getSaverBrightness(), 10);
    assert.equal(api.isCustomSaverBrightness(), false);
    api.setSaverBrightness('150');
    assert.equal(storage.get(SAVER_BRIGHTNESS_KEY), '100');
    assert.equal(api.getSaverBrightness(), 10);
    api.setCustomSaverBrightnessEnabled(true);
    assert.equal(storage.get(SAVER_BRIGHTNESS_CUSTOM_KEY), 'true');
    assert.equal(api.isCustomSaverBrightness(), true);
    assert.equal(api.getSaverBrightness(), 100);
    api.setSaverBrightness('0');
    assert.equal(api.getSaverBrightness(), 0);
    api.setSaverBrightness('abc');
    assert.equal(storage.get(SAVER_BRIGHTNESS_KEY), '10');
    api.setSaverBrightness(40.6);
    assert.equal(api.getSaverBrightness(), 41);
    api.setBlackScreenSaver(true);
    assert.equal(api.getSaverBrightness(), 0);
    api.setBlackScreenSaver(false);
    assert.equal(api.getSaverBrightness(), 41);
    api.setCustomSaverBrightnessEnabled(false);
    assert.equal(storage.get(SAVER_BRIGHTNESS_CUSTOM_KEY), 'false');
    assert.equal(api.getSaverBrightness(), 10);
});

test('equal awake/saver brightness skips capture and restores the remembered brightness', () => {
    const { api, sent } = brightnessApi({ [SAVER_BRIGHTNESS_CUSTOM_KEY]: 'true', [SAVER_BRIGHTNESS_KEY]: '75' });
    // Distinct from the current socket frame so an accidental capture would fail.
    api.rememberBrightness(62);
    api.dimDisplay();
    api.restoreDisplay();
    assert.deepEqual(sent, [
        { command: 'setBrightness', brightness: 75 },
        { command: 'setBrightness', brightness: 62 },
    ]);
});

test('both saver preferences are synced and restored after local storage is wiped', async () => {
    assert.ok(SYNCED_KEYS.includes(SAVER_BRIGHTNESS_KEY));
    assert.ok(SYNCED_KEYS.includes(SAVER_BRIGHTNESS_CUSTOM_KEY));
    const restored = {};
    const remote = { [SAVER_BRIGHTNESS_KEY]: '0', [SAVER_BRIGHTNESS_CUSTOM_KEY]: 'true' };
    await hydrate({ getItem: () => null }, remote, (key, value) => { restored[key] = value; }, () => {});
    assert.deepEqual(restored, remote);
    assert.equal(resolveSaverBrightness(parseSaverBrightnessSetting(
        restored[SAVER_BRIGHTNESS_CUSTOM_KEY], restored[SAVER_BRIGHTNESS_KEY],
    )), 0);
});
