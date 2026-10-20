import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

// "Clear button" on an R/F cell takes the item off the strip, mirroring the profile strip's
// own favourite menu. DYE2 owns the flag and both flags default to shown when absent, so
// clearing writes false rather than deleting the item -- it stays in DYE2, editable.
//
// dyeStrip.js can't be imported under node (browser globals), so the functions under test are
// lifted out of the source and run with their dependencies injected -- same trick as
// dye2-plugin-source.test.mjs.
function lift(patterns) {
    const source = readFileSync(new URL('../src/modules/dyeStrip.js', import.meta.url), 'utf8');
    return patterns.map(pattern => {
        const match = source.match(pattern);
        assert.ok(match, `dyeStrip.js: no match for ${pattern}`);
        return match[0].replace('export ', '');
    }).join('\n');
}

const body = lift([
    /async function saveItemTopLevel\([\s\S]*?\r?\n\}/,
    /async function clearCell\([\s\S]*?\r?\n\}/,
]);

function build({ recipes = [], favs = [], armed = null } = {}) {
    const state = { written: null, key: null, toasts: [], selectionCleared: 0, rendered: 0 };
    const api = new Function(
        'RECIPES_KEY', 'AF_KEY', 'getDye2KvArray', 'setDye2KvArray', 'logger', 'showToast',
        'recipeLabel', 'favLabel', 'clearSelection', 'renderStrip', 'activeItemId', 'currentMode', 'state',
        `let recipeCache = [], favCache = [];
         ${body}
         return { clearCell, saveItemTopLevel, caches: () => ({ recipeCache, favCache }) };`
    )(
        'recipes', 'autoFavourites',
        async (key) => (key === 'recipes' ? recipes : favs).map(x => ({ ...x })),
        async (key, items) => { state.key = key; state.written = items; },
        { info() {}, error() {} },
        (msg, _d, type) => state.toasts.push({ msg, type }),
        (r) => r.title || 'Recipe',
        (f) => f.title || 'Favourite',
        () => { state.selectionCleared++; },
        () => { state.rendered++; },
        armed,
        'R',
        state,
    );
    return { api, state };
}

test('clearing a recipe cell hides just that recipe, and leaves the item in DYE2', async () => {
    const { api, state } = build({ recipes: [{ id: '1', title: 'A' }, { id: '2', title: 'B' }] });
    await api.clearCell('recipe', { id: '2', title: 'B' });

    assert.equal(state.key, 'recipes');
    assert.equal(state.written.length, 2, 'nothing is deleted -- the recipe stays in DYE2');
    assert.equal(state.written[1].showOnStreamlineDashboard, false, 'the cleared one is hidden');
    assert.equal(state.written[1].title, 'B', 'and keeps its own data');
    assert.ok(!('showOnStreamlineDashboard' in state.written[0]), 'the other cell is untouched');
    assert.deepEqual(state.toasts, [{ msg: 'B cleared', type: 'info' }]);
    assert.equal(state.rendered, 1, 'the strip redraws so the cell goes blank');
});

test('clearing a favourite cell writes the favourite flag, not the recipe one', async () => {
    const { api, state } = build({ favs: [{ id: 'af1', title: 'Fav' }] });
    await api.clearCell('favourite', { id: 'af1', title: 'Fav' });

    assert.equal(state.key, 'autoFavourites');
    assert.equal(state.written[0].alwaysOnDashboard, false);
    assert.ok(!('showOnStreamlineDashboard' in state.written[0]));
});

test('clearing the armed item also drops the selection, so nothing records onto it', async () => {
    const { api, state } = build({ recipes: [{ id: '1', title: 'A' }], armed: '1' });
    await api.clearCell('recipe', { id: '1', title: 'A' });

    assert.equal(state.selectionCleared, 1, 'an item off the strip must not stay armed');
    assert.equal(state.rendered, 0, 'clearSelection redraws, so the strip is not drawn twice');
});

test('an item that has gone from DYE2 since the strip read it writes nothing', async () => {
    const { api, state } = build({ recipes: [{ id: '1', title: 'A' }] });
    await api.clearCell('recipe', { id: '9', title: 'Gone' });

    assert.equal(state.written, null, 'no write');
    assert.equal(state.toasts[0].msg, 'Gone is no longer in DYE2');
    assert.equal(state.selectionCleared, 0);
});
