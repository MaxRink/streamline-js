import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');

test('long press uses pointer events without blocking touch start', () => {
    const ui = read('src/modules/ui.js');
    const helper = ui.slice(ui.indexOf('export function setupPressAndHold'), ui.indexOf('export function flashElement'));
    const startPress = helper.slice(helper.indexOf('const startPress'), helper.indexOf('const movePress'));
    assert.match(helper, /addEventListener\('pointerdown'/);
    assert.match(helper, /addEventListener\('pointermove'/);
    assert.match(helper, /addEventListener\('pointercancel'/);
    assert.match(helper, /Math\.hypot\([\s\S]*movementThreshold/);
    assert.doesNotMatch(helper, /touchstart|mousedown/);
    assert.doesNotMatch(startPress, /preventDefault/);
    assert.match(helper, /stopImmediatePropagation/);
});

test('tablet menus use larger rows, bottom sheets and focus restoration', () => {
    const menu = read('src/modules/context-menu.js');
    const layout = read('src/modules/context-menu-layout.js');
    const css = read('src/css/context-menu.css');
    // The sheet is now phone-only: it is pinned left:12px/right:12px with
    // max-width:none, which spanned the full width of the coarse-pointer,
    // ~1920px Decent tablet. The action threshold moved to the DOM-free policy
    // module and gained a viewport-width bound alongside it.
    assert.match(layout, /BOTTOM_SHEET_MIN_ACTIONS = 4/);
    assert.match(layout, /BOTTOM_SHEET_MAX_WIDTH = \d+/);
    assert.match(menu, /shouldUseBottomSheet\(/);
    assert.match(menu, /anchor\.focus\(\{ preventScroll: true \}\)/);
    assert.match(css, /@media \(pointer: coarse\)[\s\S]*min-height: 60px/);
    assert.match(css, /context-menu--bottom-sheet/);
    assert.match(css, /#sub-categories-separator::after[\s\S]*width: 48px/);
});

// The per-row overflow (⋮) button is gone: long press is the affordance, as it
// already is for the favourite buttons and the profile name on the main page.
// Right-click opens the same menu so a mouse still has a way in.
test('profile rows open their menu by long press and right-click, with no overflow button', () => {
    const profiles = read('src/modules/profile_selector.js');
    assert.doesNotMatch(profiles, /profile-context-trigger/);
    assert.match(profiles, /setupPressAndHold\(div, selectItem, openMenu, \{ touchAction: 'pan-y' \}\)/);
    assert.match(profiles, /addEventListener\('contextmenu'/);
    assert.match(profiles, /aria-haspopup/);
});
