import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SAVER_BRIGHTNESS_DEFAULT } from '../src/modules/saver-brightness.js';
import {
    SCREENSAVER_CLOCK_FORMATS, SCREENSAVER_CLOCK_POSITIONS,
    resolveScreensaverClockFormat, resolveScreensaverClockPosition,
    formatScreensaverClockTime, screensaverClockPositionStyle,
    SCREENSAVER_DATE_FORMATS, formatScreensaverClockDate, resolveScreensaverDateFormat,
} from '../src/modules/screensaver-clock.js';

test('missing or unrecognized preferences preserve locale time and bottom center', () => {
    for (const value of [undefined, null, '', 'invalid', '<script>']) {
        assert.equal(resolveScreensaverClockFormat(value), 'locale');
        assert.equal(resolveScreensaverClockPosition(value), 'bottom-center');
    }
    assert.deepEqual(screensaverClockPositionStyle(null), {
        top: 'auto', bottom: '8%', left: '0px', right: '0px',
        alignItems: 'center', textAlign: 'center',
    });
});

test('explicit 12/24-hour choices work at midnight, noon, and afternoon in either locale', () => {
    for (const locale of ['en-US', 'en-GB']) {
        for (const [hour, expected12, expected24] of [
            [0, '12:07 AM', '00:07'],
            [12, '12:07 PM', '12:07'],
            [23, '11:07 PM', '23:07'],
        ]) {
            const date = new Date(2026, 9, 13, hour, 7);
            assert.equal(formatScreensaverClockTime(date, '12', locale).toUpperCase(), expected12);
            assert.equal(formatScreensaverClockTime(date, '24', locale), expected24);
            assert.equal(formatScreensaverClockTime(date, null, locale),
                date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }));
        }
    }
});

test('all six positions set both vertical edges and horizontal alignment', () => {
    assert.deepEqual(SCREENSAVER_CLOCK_POSITIONS.map(option => option.value), [
        'top-left', 'top-center', 'top-right',
        'bottom-left', 'bottom-center', 'bottom-right',
    ]);
    for (const { value } of SCREENSAVER_CLOCK_POSITIONS) {
        const [vertical, horizontal] = value.split('-');
        const style = screensaverClockPositionStyle(value);
        assert.equal(style.top, vertical === 'top' ? '8%' : 'auto');
        assert.equal(style.bottom, vertical === 'bottom' ? '8%' : 'auto');
        assert.equal(style.alignItems, { left: 'flex-start', center: 'center', right: 'flex-end' }[horizontal]);
        assert.equal(style.textAlign, horizontal);
        assert.equal(style.left, horizontal === 'center' ? '0px' : '5%');
        assert.equal(style.right, style.left);
    }
});

function clockHarness() {
    const source = readFileSync(new URL('../src/modules/ui.js', import.meta.url), 'utf8');
    const functions = [
        '_updateScreensaverClock', '_syncScreensaverClock', 'setScreensaverClockEnabled',
        'setScreensaverClockFormat', 'setScreensaverClockPosition', 'setScreensaverDateFormat',
    ].map(name => {
        const match = source.match(new RegExp(`(?:export )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\r?\\n\\}`));
        assert.ok(match, `${name} is wired in ui.js`);
        return match[0].replace('export ', '');
    }).join('\n');
    const stored = new Map();
    const intervals = new Map();
    const clock = { style: {} }, time = {}, date = {};
    let nextTimer = 0;
    const api = new Function(
        'localStorage', 'setInterval', 'clearInterval', 'screensaverClockEl',
        'screensaverClockTimeEl', 'screensaverClockDateEl',
        'SCREENSAVER_CLOCK_FORMATS', 'SCREENSAVER_CLOCK_POSITIONS',
        'formatScreensaverClockTime', 'screensaverClockPositionStyle',
        'SCREENSAVER_DATE_FORMATS', 'formatScreensaverClockDate',
        `let screensaverActive = false, screensaverClockTimer = null;
         ${functions}
         return { setScreensaverClockEnabled, setScreensaverClockFormat, setScreensaverClockPosition,
             setActive(active) { screensaverActive = active; _syncScreensaverClock(); } };`,
    )(
        { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) },
        callback => { intervals.set(++nextTimer, callback); return nextTimer; },
        timer => intervals.delete(timer), clock, time, date,
        SCREENSAVER_CLOCK_FORMATS, SCREENSAVER_CLOCK_POSITIONS,
        formatScreensaverClockTime, screensaverClockPositionStyle,
        SCREENSAVER_DATE_FORMATS, formatScreensaverClockDate,
    );
    return { api, stored, intervals, clock, time, date, source };
}

test('clock settings persist and apply live without accumulating timers', () => {
    const { api, stored, intervals, clock, time, date } = clockHarness();
    api.setActive(true);
    assert.equal(clock.style.display, 'flex');
    assert.equal(intervals.size, 1);
    assert.ok(time.textContent);
    assert.ok(date.textContent);
    api.setScreensaverClockFormat('24');
    assert.equal(stored.get('screensaverClockFormat'), '24');
    assert.match(time.textContent, /^\d{2}:\d{2}$/);
    for (const { value } of SCREENSAVER_CLOCK_POSITIONS) {
        api.setScreensaverClockPosition(value);
        assert.equal(stored.get('screensaverClockPosition'), value);
        assert.equal(clock.style.top, value.startsWith('top') ? '8%' : 'auto');
        assert.equal(intervals.size, 1);
    }
    api.setScreensaverClockEnabled(false);
    assert.equal(clock.style.display, 'none');
    assert.equal(intervals.size, 0);
    api.setScreensaverClockEnabled(true);
    assert.equal(intervals.size, 1);
    api.setActive(false);
    assert.equal(clock.style.display, 'none');
    assert.equal(intervals.size, 0);
    assert.throws(() => api.setScreensaverClockFormat('invalid'), RangeError);
    assert.throws(() => api.setScreensaverClockPosition('invalid'), RangeError);
    assert.equal(stored.get('screensaverClockFormat'), '24');
    assert.equal(stored.get('screensaverClockPosition'), 'bottom-right');
});

test('late restoration is picked up by the active ticker', () => {
    const { api, stored, intervals, clock, time } = clockHarness();
    api.setActive(true);
    stored.set('screensaverClockPosition', 'top-right');
    stored.set('screensaverClockFormat', '24');
    [...intervals.values()][0]();
    assert.equal(clock.style.top, '8%');
    assert.equal(clock.style.alignItems, 'flex-end');
    assert.match(time.textContent, /^\d{2}:\d{2}$/);
});

test('both saver modes sync the clock and hiding stops it', () => {
    const { source } = clockHarness();
    const activate = source.match(/export function activateScreensaver\(\) \{[\s\S]*?\r?\n\}/)[0];
    assert.match(activate, /if \(isBlackScreenSaver\(\)\)[\s\S]*?_syncScreensaverClock\(\);[\s\S]*?return;/);
    assert.equal((activate.match(/_syncScreensaverClock\(\);/g) || []).length, 2);
    assert.match(source, /export function hideScreensaver\(\) \{[\s\S]*?screensaverActive = false;\s+_syncScreensaverClock\(\);/);
});

function renderSaverSettings(preferences = {}, saver = {}) {
    const source = readFileSync(new URL('../src/settings/settings.js', import.meta.url), 'utf8');
    const match = source.match(/export function renderScreenSaverSettings\(\) \{[\s\S]*?\r?\n\}/);
    assert.ok(match);
    const render = new Function(
        'localStorage', 'SCREENSAVER_CLOCK_FORMATS', 'SCREENSAVER_CLOCK_POSITIONS',
        'resolveScreensaverClockFormat', 'resolveScreensaverClockPosition',
        'SCREENSAVER_DATE_FORMATS', 'resolveScreensaverDateFormat',
        'saver', 'SAVER_BRIGHTNESS_DEFAULT', 'getTranslation',
        `const screensaverImagesCache = [], isBlackScreenSaver = () => saver.black === true, displayState = () => ({});
         const isCustomSaverBrightness = () => saver.custom === true;
         const getSaverBrightness = () => saver.level ?? SAVER_BRIGHTNESS_DEFAULT;
         ${match[0].replace('export ', '')}
         return renderScreenSaverSettings();`,
    );
    return render(
        { getItem: key => preferences[key] ?? null },
        SCREENSAVER_CLOCK_FORMATS, SCREENSAVER_CLOCK_POSITIONS,
        resolveScreensaverClockFormat, resolveScreensaverClockPosition,
        SCREENSAVER_DATE_FORMATS, resolveScreensaverDateFormat,
        saver, SAVER_BRIGHTNESS_DEFAULT, key => key,
    );
}

test('settings render persisted choices, six positions, and safe defaults', () => {
    for (const preferences of [
        { screensaverClockFormat: '24', screensaverClockPosition: 'top-right' },
        { screensaverClockFormat: '<script>', screensaverClockPosition: '<script>' },
    ]) {
        const html = renderSaverSettings(preferences);
        const format = html.match(/<select id="screensaver-clock-format"[\s\S]*?<\/select>/)[0];
        const position = html.match(/<select id="screensaver-clock-position"[\s\S]*?<\/select>/)[0];
        assert.equal((format.match(/<option /g) || []).length, 3);
        assert.equal((position.match(/<option /g) || []).length, 6);
        assert.ok(format.includes(`value="${resolveScreensaverClockFormat(preferences.screensaverClockFormat)}" selected`));
        assert.ok(position.includes(`value="${resolveScreensaverClockPosition(preferences.screensaverClockPosition)}" selected`));
        assert.ok(!html.includes('<script>'));
        assert.match(html, /label for="screensaver-clock-format"/);
        assert.match(html, /label for="screensaver-clock-position"/);
        assert.equal((html.match(/<select id="screensaver-date-format"[\s\S]*?<\/select>/)[0].match(/<option /g) || []).length, 5);
    }
});

test('saver style defaults to Images and Black keeps clock/date controls only', () => {
    const images = renderSaverSettings();
    assert.match(images, /aria-pressed="true"\s+onclick="window.setBlackScreenSaver\(false\)"/);
    assert.match(images, /onclick="window.setBlackScreenSaver\(true\)"/);
    assert.ok(images.indexOf('screensaver-style-label') < images.indexOf('screensaver-file-input'));
    assert.match(images, /id="screensaver-file-input"/);
    assert.match(images, /id="saver-brightness-custom"/);
    assert.match(images, /id="saver-brightness-slider"/);
    assert.doesNotMatch(images, /id="brightness-(slider|number)"/);

    const black = renderSaverSettings({}, { black: true });
    assert.match(black, /aria-pressed="true"\s+onclick="window.setBlackScreenSaver\(true\)"/);
    assert.doesNotMatch(black, /id="(?:screensaver-file-input|screensaver-cycle-seconds|saver-brightness-custom|saver-brightness-slider)"/);
    assert.doesNotMatch(black, /Choose Images|No custom images/);
    for (const id of ['screensaver-show-clock', 'screensaver-clock-format', 'screensaver-date-format', 'screensaver-clock-position']) {
        assert.ok(black.includes(`id="${id}"`));
    }
});

test('custom saver brightness preserves zero and opt-out shows the effective default', () => {
    const custom = renderSaverSettings({}, { custom: true, level: 0 });
    const customSlider = custom.match(/<input type="range"[^>]*>/)[0];
    assert.match(customSlider, /id="saver-brightness-slider" min="0" max="100" step="1" value="0"/);
    assert.doesNotMatch(customSlider, /disabled/);
    assert.match(custom, /id="saver-brightness-value"[^>]*>0%/);
    assert.match(custom, /id="saver-brightness-custom" checked/);
    assert.match(custom, /onchange="window.setCustomSaverBrightness\(this.checked\)"/);
    assert.match(customSlider, /oninput="window.setSaverBrightnessLevel\(this.value\)"/);

    const automatic = renderSaverSettings({}, { custom: false, level: 73 });
    const automaticSlider = automatic.match(/<input type="range"[^>]*>/)[0];
    assert.match(automaticSlider, new RegExp(`value="${SAVER_BRIGHTNESS_DEFAULT}"`));
    assert.match(automaticSlider, /disabled/);
    assert.match(automatic, new RegExp(`id="saver-brightness-value"[^>]*>${SAVER_BRIGHTNESS_DEFAULT}%`));
});

test('date format presets are locale-independent and fall back to the long form', () => {
    const date = new Date(2026, 0, 5, 9, 0);
    assert.equal(formatScreensaverClockDate(date, 'dmy'), '05/01/2026');
    assert.equal(formatScreensaverClockDate(date, 'mdy'), '01/05/2026');
    assert.equal(formatScreensaverClockDate(date, 'ymd'), '2026-01-05');
    assert.equal(formatScreensaverClockDate(date, 'none'), '');
    for (const bad of [undefined, null, 'x', '<b>']) assert.equal(resolveScreensaverDateFormat(bad), 'long');
    assert.equal(formatScreensaverClockDate(date, null, 'en-US'),
        date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }));
});
