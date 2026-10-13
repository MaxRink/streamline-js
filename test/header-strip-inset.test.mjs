// Header strip bounds on a scaled dashboard (src/modules/header-strip-inset.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripRightInset } from '../src/modules/header-strip-inset.js';

test('at the design size the measured gap is used as it is', () => {
    assert.equal(stripRightInset({ headerRight: 1280, headerWidth: 1280, headerLayoutWidth: 1280, controlsLeft: 1000, gap: 20 }), 300);
});

test('on a scaled dashboard the gap is converted to layout pixels', () => {
    // Shown at half size: 140 screen pixels of controls are 280 of the header's own.
    assert.equal(stripRightInset({ headerRight: 640, headerWidth: 640, headerLayoutWidth: 1280, controlsLeft: 500, gap: 20 }), 300);
    // Shown larger (1.25x).
    assert.equal(stripRightInset({ headerRight: 1600, headerWidth: 1600, headerLayoutWidth: 1280, controlsLeft: 1250, gap: 20 }), 300);
});

test('a header not laid out yet, or controls past the edge, give no negative inset', () => {
    assert.equal(stripRightInset({ headerRight: 0, headerWidth: 0, headerLayoutWidth: 0, controlsLeft: 0, gap: 20 }), 20);
    assert.equal(stripRightInset({ headerRight: 100, headerWidth: 100, headerLayoutWidth: 100, controlsLeft: 200, gap: 20 }), 0);
});
