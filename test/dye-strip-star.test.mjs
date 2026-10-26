import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { armedSelectionId, selectionModified, recipeCellState } from '../src/modules/dye-selection.js';

// The `*` on a recipe cell: drives the real saveChanges / syncSelection / setStripMode-refresh
// lifted out of dyeStrip.js (browser globals) with injected deps.
function lift(patterns) {
    const source = readFileSync(new URL('../src/modules/dyeStrip.js', import.meta.url), 'utf8');
    return patterns.map(p => {
        const m = source.match(p);
        assert.ok(m, `no match for ${p}`);
        return m[0].replace('export ', '');
    }).join('\n');
}
const body = lift([
    /async function readSelection\([\s\S]*?\r?\n\}/,
    /async function syncSelection\([\s\S]*?\r?\n\}/,
    /async function saveChanges\([\s\S]*?\r?\n\}/,
]);
const repollSrc = readFileSync(new URL('../src/modules/dyeStrip.js', import.meta.url), 'utf8')
    .match(/const repoll = \(\) => \{[\s\S]*?\r?\n    \};/)[0];

// route: what GET /selection answers; mirror: what the KV key holds (can be stale).
function build({ route, mirror, recordBody = { saved: true }, activeItem = null, records = true } = {}) {
    const st = { route, mirror, toasts: [], renders: 0, hidden: false };
    const fetchFn = async (url, opts = {}) => {
        if (url.endsWith('/record')) return { ok: true, status: 200, json: async () => recordBody };
        if (url.endsWith('/selection')) {
            if (st.route === 'down') throw new Error('down');
            return { ok: true, status: 200, json: async () => st.route };
        }
        throw new Error(url);
    };
    const mod = new Function(
        'fetch', 'PLUGIN_BASE', 'getKVValue', 'DYE2_KV_NAMESPACE', 'armedSelectionId', 'selectionModified',
        'loadDyeStripDataUnused', 'renderStrip', 'showToast', 'logger', 'recipeLabel', 'favLabel', 'updateDye2Now',
        'document', 'isDye2Enabled', 'st',
        `let activeItemId = '2', activeModified = true, activeItem = ${JSON.stringify(activeItem)}, applySeq = 0,
             dye2RecordsDialIn = ${records}, currentMode = 'R', recipeCache = [{ id: '1' }, { id: '2' }], favCache = [];
         const loadDyeStripData = async () => { if (st.loadSetsStar) activeModified = true; };
         ${body}
         ${repollSrc}
         return { saveChanges, syncSelection, repoll, state: () => ({ activeItemId, activeModified }),
                  tap: id => { activeItemId = id; activeModified = false; }, setItem: v => { activeItem = v; } };`
    )(fetchFn, 'http://x/plugins/dye2', async () => st.mirror, 'dye2', armedSelectionId, selectionModified,
      async () => {}, () => { st.renders++; }, (m) => st.toasts.push(m), { warn() {}, error() {} },
      r => r.id, f => f.id, async () => false, st, () => true, st);
    return { mod, st };
}
const staleMirror = { kind: 'recipe', id: '2', modified: true };
const derivedClean = { kind: 'recipe', id: '2', modified: false };

test('successful save clears the star and a stale KV mirror cannot bring it back', async () => {
    const { mod } = build({ route: derivedClean, mirror: staleMirror });
    await mod.saveChanges('recipe', { id: '2' });
    assert.deepEqual(mod.state(), { activeItemId: '2', activeModified: false });
    // the refresh that normally follows (workflow-refresh push / focus)
    await mod.repoll();
    await new Promise(r => setTimeout(r));
    assert.deepEqual(mod.state(), { activeItemId: '2', activeModified: false }, 'repoll reads the derived route, not the mirror');
});

test('post-save sync with the route down keeps the local clear (never trusts the stale mirror)', async () => {
    const { mod } = build({ route: 'down', mirror: staleMirror });
    await mod.saveChanges('recipe', { id: '2' });
    assert.equal(mod.state().activeModified, false);
});

test('saved:false leaves the star (drift is still real)', async () => {
    const { mod, st } = build({ route: { kind: 'recipe', id: '2', modified: true }, mirror: staleMirror, recordBody: { saved: false } });
    await mod.saveChanges('recipe', { id: '2' });
    assert.equal(mod.state().activeModified, true);
    assert.deepEqual(st.toasts, ['No changes to save']);
});

test('saved:false because it was already saved: star clears from the derived answer', async () => {
    const { mod } = build({ route: derivedClean, mirror: staleMirror, recordBody: { saved: false } });
    await mod.saveChanges('recipe', { id: '2' });
    assert.equal(mod.state().activeModified, false);
});

test('a loadDyeStripData that re-sets the flag cannot leave the star on (saved true and false)', async () => {
    for (const saved of [true, false]) {
        const { mod, st } = build({ route: derivedClean, mirror: staleMirror, recordBody: { saved } });
        st.loadSetsStar = true;
        await mod.saveChanges('recipe', { id: '2' });
        assert.equal(mod.state().activeModified, false, `saved:${saved}`);
    }
});

test('focus / changed push (repoll) lights the star when DYE2 says modified, clears it when the value is set back', async () => {
    const { mod, st } = build({ route: { kind: 'recipe', id: '2', modified: true }, mirror: null });
    await mod.repoll(); await new Promise(r => setTimeout(r));
    assert.equal(mod.state().activeModified, true);
    st.route = derivedClean;
    await mod.repoll(); await new Promise(r => setTimeout(r));
    assert.equal(mod.state().activeModified, false, 'value changed back to the recipe own: star goes');
});

test('id and modified refresh together: a different selection moves the highlight and drops the old star', async () => {
    const { mod } = build({ route: { kind: 'recipe', id: '1', modified: false }, mirror: null });
    assert.equal(await mod.syncSelection(), true);
    assert.deepEqual(mod.state(), { activeItemId: '1', activeModified: false });
    assert.deepEqual(recipeCellState({ id: '2' }, '1', false), { active: false, marker: '' });
});

test('a deselected workflow clears both', async () => {
    const { mod } = build({ route: null, mirror: null });
    await mod.syncSelection();
    assert.deepEqual(mod.state(), { activeItemId: null, activeModified: false });
});

test('a legacy armed activeItem never shows a star and is not overwritten', async () => {
    const { mod } = build({ route: { kind: 'recipe', id: '1', modified: true }, mirror: null, activeItem: { kind: 'recipe', id: '2' } });
    assert.equal(await mod.syncSelection(), false);
    assert.deepEqual(mod.state(), { activeItemId: '2', activeModified: false });
});

test('a tap during the GET wins over the late answer', async () => {
    const { mod } = build({ route: { kind: 'recipe', id: '2', modified: true }, mirror: null });
    const p = mod.syncSelection();
    mod.tap('1');
    assert.equal(await p, false);
    assert.deepEqual(mod.state(), { activeItemId: '1', activeModified: false });
});

test('route unreachable falls back to the KV mirror for ordinary refreshes', async () => {
    const { mod } = build({ route: 'down', mirror: derivedClean });
    assert.equal(await mod.syncSelection(), true);
    assert.equal(mod.state().activeModified, false);
});

test('recipeCellState stars only the highlighted cell', () => {
    assert.equal(recipeCellState({ id: '2' }, '2', true).marker, '*');
    assert.equal(recipeCellState({ id: '1' }, '2', true).marker, '');
});

// #159 acceptance 1: the highlight is derived -- a highlighted cell means the live workflow already
// IS that item. Re-applying it would write the same values back and undo anything changed since, so
// the tap is inert. A drifted recipe (`*`) counts as highlighted: the drift is resolved by "Save
// changes" or in DYE2, never by a tap silently reverting the machine.
test('tapping a highlighted cell writes nothing, on both strips', () => {
    const source = readFileSync(new URL('../src/modules/dyeStrip.js', import.meta.url), 'utf8');

    const fav = source.slice(source.indexOf('makeCell(favLabel(fav)'));
    const favTap = fav.slice(0, fav.indexOf('applyFavourite(fav)'));
    assert.ok(/if \(active\) return;/.test(favTap), 'favourite tap returns before applyFavourite');
    assert.ok(favTap.indexOf('if (active) return;') < favTap.indexOf('activeItemId = fav.id'),
        'and before any state is touched');

    const rec = source.slice(source.indexOf('makeCell(recipeLabel(recipe) + marker'));
    const recTap = rec.slice(0, rec.indexOf('applyRecipe(recipe)'));
    assert.ok(/if \(active\) return;/.test(recTap), 'recipe tap returns before applyRecipe');
    assert.ok(recTap.indexOf('if (active) return;') < recTap.indexOf('activeItemId = recipe.id'),
        'and before any state is touched');
    // `active` comes from recipeCellState, which is true for a starred cell too.
    assert.equal(recipeCellState({ id: '1' }, '1', true).active, true, 'a drifted cell is still highlighted');
});
