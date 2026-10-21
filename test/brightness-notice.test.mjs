import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    SYSTEM_MANAGED_BRIGHTNESS,
    SYSTEM_MANAGED_NOTICE,
    SAVER_DIM_NOTICE,
    SAVER_BLACK_NOTICE,
    LOW_BATTERY_NOTICE,
    QUEUED_NOTICE,
    isSystemManagedBrightness,
    brightnessNotices,
    REQUESTED_APPLIED_TEMPLATE,
    GO_TO_SETTING_LABEL,
    LOW_BATTERY_SETTING_CATEGORY,
    requestedBrightnessReadout
} from '../src/modules/brightness-notice.js';

test('100 is the only value that hands control to the system', () => {
    assert.equal(SYSTEM_MANAGED_BRIGHTNESS, 100);
    assert.equal(isSystemManagedBrightness(100), true);
    assert.equal(isSystemManagedBrightness(99), false);
    assert.equal(isSystemManagedBrightness(0), false);
});

test('a missing or non-numeric level never claims the system is in control', () => {
    // displayState() can be null before the first display frame lands, and the
    // panel then falls back to 100 -- but undefined must not be read as 100.
    for (const value of [undefined, null, NaN, '100', {}]) {
        assert.equal(isSystemManagedBrightness(value), false, `value: ${String(value)}`);
    }
});

test('100 explains the system handoff; anything below stays quiet', () => {
    assert.deepEqual(brightnessNotices({ brightness: 100 }), [SYSTEM_MANAGED_NOTICE, SAVER_DIM_NOTICE]);
    assert.deepEqual(brightnessNotices({ brightness: 40 }), [SAVER_DIM_NOTICE]);
    assert.deepEqual(brightnessNotices({ brightness: 0 }), [SAVER_DIM_NOTICE]);
});

test('the screensaver notice follows the black-screen-saver preference', () => {
    assert.deepEqual(brightnessNotices({ brightness: 40, blackScreenSaver: true }), [SAVER_BLACK_NOTICE]);
    assert.deepEqual(brightnessNotices({ brightness: 40, blackScreenSaver: false }), [SAVER_DIM_NOTICE]);
});

test('both notices show at 100 with the black saver, in a stable order', () => {
    assert.deepEqual(
        brightnessNotices({ brightness: 100, blackScreenSaver: true }),
        [SYSTEM_MANAGED_NOTICE, SAVER_BLACK_NOTICE]
    );
});

test('an empty state still explains the screensaver rather than rendering nothing', () => {
    // The panel is reachable before the first display frame, so brightness can
    // be absent entirely; the saver behaviour is always worth explaining.
    assert.deepEqual(brightnessNotices(), [SAVER_DIM_NOTICE]);
    assert.deepEqual(brightnessNotices({}), [SAVER_DIM_NOTICE]);
});

test('notice text is safe to use as a data-i18n-key attribute', () => {
    // These strings are interpolated into HTML attributes, and translatePage()
    // assigns them as textContent. No quote, bracket or ampersand may appear.
    for (const notice of [SYSTEM_MANAGED_NOTICE, SAVER_DIM_NOTICE, SAVER_BLACK_NOTICE, LOW_BATTERY_NOTICE, QUEUED_NOTICE]) {
        assert.doesNotMatch(notice, /["'<>&]/, `unsafe notice: ${notice}`);
        assert.ok(notice.trim().length > 0);
    }
});

test('the low-battery cap gets its own notice, only while it is active', () => {
    assert.deepEqual(
        brightnessNotices({ brightness: 20, lowBatteryActive: true }),
        [LOW_BATTERY_NOTICE, SAVER_DIM_NOTICE]
    );
    assert.deepEqual(brightnessNotices({ brightness: 20, lowBatteryActive: false }), [SAVER_DIM_NOTICE]);
    // Only a real true counts: a missing field must not claim a cap.
    assert.deepEqual(brightnessNotices({ brightness: 20, lowBatteryActive: 'yes' }), [SAVER_DIM_NOTICE]);
    assert.match(LOW_BATTERY_NOTICE, /Dim the screen when low battery/, 'points at the toggle by its label');
    assert.match(LOW_BATTERY_NOTICE, /Machine, USB/, 'points at where the toggle actually lives');
});

test('every notice can show together in a stable order', () => {
    assert.deepEqual(
        brightnessNotices({ brightness: 100, lowBatteryActive: true, blackScreenSaver: true }),
        [SYSTEM_MANAGED_NOTICE, LOW_BATTERY_NOTICE, SAVER_BLACK_NOTICE]
    );
});

test('requested-vs-applied readout appears only when the two differ', () => {
    assert.equal(requestedBrightnessReadout({ requested: 80, applied: 20 }, REQUESTED_APPLIED_TEMPLATE), 'Requested 80% \u00b7 applied 20%');
    assert.equal(requestedBrightnessReadout({ requested: 20, applied: 20 }), null);
    assert.equal(requestedBrightnessReadout({ requested: 20.2, applied: 19.8 }), null);
    for (const bad of [undefined, null, NaN, '80', Infinity]) {
        assert.equal(requestedBrightnessReadout({ requested: bad, applied: 20 }), null);
        assert.equal(requestedBrightnessReadout({ requested: 80, applied: bad }), null);
    }
    assert.equal(requestedBrightnessReadout(), null);
    assert.equal(requestedBrightnessReadout({ requested: 80, applied: 20 }, 'Demande {requested}% / appliquee {applied}%'), 'Demande 80% / appliquee 20%');
});

test('readout template and jump label are safe static i18n keys', () => {
    for (const text of [REQUESTED_APPLIED_TEMPLATE, GO_TO_SETTING_LABEL]) assert.doesNotMatch(text, /[<>&"']/);
    assert.equal(LOW_BATTERY_SETTING_CATEGORY, 'usbchargermode');
});
