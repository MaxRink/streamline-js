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

// Recording is opt-in now: DYE2 only writes dial-in onto the selected item when the barista
// asks. The menu entry is the only way to ask, and it must be offered on the selected cell
// only -- DYE2 records onto its own selection, so on any other cell it would hit the wrong item.
test('Save changes is offered on the selected cell only', () => {
    const source = readFileSync(new URL('../src/modules/dyeStrip.js', import.meta.url), 'utf8');
    const menu = source.slice(source.indexOf('function openCellMenu('));
    const body = menu.slice(0, menu.indexOf('\n}\n'));

    assert.ok(body.includes("item.id === activeItemId"), 'the entry is gated on being selected');
    assert.ok(body.includes('dye2RecordsDialIn') && body.includes('!activeItem'),
        'and only against a DYE2 that records, with no legacy auto-save item armed');
    assert.ok(/selected \? \[\{ label: getTranslation\('Save changes'\)/.test(body), 'and only then listed');
    assert.ok(body.includes("getTranslation('Edit in DYE2')"), 'labels are translated');
    assert.ok(!body.includes("'Clear selection'"),
        'Clear selection is gone: with opt-in recording there is nothing to disarm');
    assert.ok(body.includes("getTranslation('Clear button')"), 'Clear button stays');
});

test('saveChanges asks DYE2 to record and does not write the item itself', () => {
    const source = readFileSync(new URL('../src/modules/dyeStrip.js', import.meta.url), 'utf8');
    const fn = source.slice(source.indexOf('async function saveChanges('));
    const body = fn.slice(0, fn.indexOf('\n}\n'));

    assert.ok(body.includes('/record'), 'it posts to DYE2 record route');
    assert.ok(body.includes("method: 'POST'"), 'as a POST');
    // DYE2 owns the diff -- it knows what the item held when applied. The skin must not
    // compute or write a patch of its own, or the two would disagree.
    assert.ok(!body.includes('saveItemFields') && !body.includes('setDye2KvArray'),
        'the skin writes nothing itself');
    assert.ok(body.includes('No changes to save'), 'saved:false is reported, not silent');
});

function buildSave({ status = 200, json = { saved: true }, updated = false } = {}) {
    const state = { toasts: [], loads: 0, renders: [], posts: [], updates: 0 };
    const saveBody = lift([/async function saveChanges\([\s\S]*?\r?\n\}/]);
    const api = new Function(
        'PLUGIN_BASE', 'fetch', 'logger', 'showToast', 'recipeLabel', 'favLabel', 'loadDyeStripData', 'renderStrip', 'currentMode', 'updateDye2Now',
        `${saveBody}\nreturn { saveChanges };`
    )(
        '/p',
        async (url, opts) => { state.posts.push({ url, opts }); return { status, ok: status >= 200 && status < 300, json: async () => json }; },
        { info() {}, error() {}, warn() {} },
        (msg, _d, type) => state.toasts.push({ msg, type }),
        (r) => r.title, (f) => f.title,
        async () => { state.loads++; },
        (m) => state.renders.push(m),
        'R',
        async () => { state.updates++; return updated; },
    );
    return { api, state };
}

test('saveChanges reloads the caches and re-renders when DYE2 saved something', async () => {
    const { api, state } = buildSave();
    await api.saveChanges('recipe', { id: '1', title: 'A' });
    assert.equal(state.posts[0].url, '/p/record');
    assert.equal(state.loads, 1);
    assert.deepEqual(state.renders, ['R']);
    assert.equal(state.toasts[0].msg, 'A updated');
});

test('saveChanges with saved:false leaves the caches alone', async () => {
    const { api, state } = buildSave({ json: { saved: false } });
    await api.saveChanges('recipe', { id: '1', title: 'A' });
    assert.equal(state.loads, 0);
    assert.deepEqual(state.renders, []);
    assert.equal(state.toasts[0].msg, 'No changes to save');
});

test('saveChanges on a DYE2 without /record asks for an update', async () => {
    const { api, state } = buildSave({ status: 404 });
    await api.saveChanges('favourite', { id: 'f', title: 'F' });
    assert.equal(state.updates, 1, 'it tries to update DYE2 itself first');
    assert.equal(state.posts.length, 1, 'no retry when nothing was updated');
    assert.equal(state.toasts[0].msg, 'Update DYE2 to save changes');
    assert.equal(state.loads, 0);
});

test('saveChanges retries once after DYE2 auto-updated', async () => {
    const { api, state } = buildSave({ status: 404, updated: true });
    await api.saveChanges('favourite', { id: 'f', title: 'F' });
    assert.equal(state.updates, 1);
    assert.equal(state.posts.length, 2, 'one retry, no loop');
});

test('Save to recipes is in the recipe cell menu, between Save changes and the divider, and on blank R cells', () => {
    const source = readFileSync(new URL('../src/modules/dyeStrip.js', import.meta.url), 'utf8');
    const menu = source.slice(source.indexOf('function openCellMenu('));
    const body = menu.slice(0, menu.indexOf('\n}\n'));
    assert.ok(/kind === 'recipe' \? \[\{ label: getTranslation\('Save to recipes'\)/.test(body), 'recipe cells only, translated');
    assert.ok(body.indexOf("'Save changes'") < body.indexOf("'Save to recipes'") && body.indexOf("'Save to recipes'") < body.indexOf('divider'),
        'after Save changes, before the divider');
    assert.ok(!/Save to recipes[\s\S]*dye2RecordsDialIn/.test(body), 'not gated on dial-in recording');
    assert.ok(/makeCell\('', CELL_IDLE, \(\) => editRecipe\(\{ id: slot, blank: true \}\),\s*btn => openContextMenu\(btn, \[\{ label: getTranslation\('Save to recipes'\)/.test(source),
        'a blank R cell offers it too');
});

function buildSaveRecipe({ status = 200, json = { id: 'r1', name: 'Turbo Ristretto' }, updated = false } = {}) {
    const state = { toasts: [], loads: 0, renders: [], posts: [], updates: 0 };
    const fnBody = lift([/async function saveToRecipes\([\s\S]*?\r?\n\}/]);
    const api = new Function(
        'PLUGIN_BASE', 'fetch', 'logger', 'showToast', 'loadDyeStripData', 'renderStrip', 'currentMode', 'updateDye2Now',
        `${fnBody}\nreturn { saveToRecipes };`
    )(
        '/p',
        async (url, opts) => { state.posts.push({ url, opts }); return { status, ok: status >= 200 && status < 300, json: async () => json }; },
        { info() {}, error() {}, warn() {} },
        (msg, _d, type) => state.toasts.push({ msg, type }),
        async () => { state.loads++; },
        (m) => state.renders.push(m),
        'R',
        async () => { state.updates++; return updated; },
    );
    return { api, state };
}

test('saveToRecipes posts an empty body, reloads, re-renders and toasts the returned name', async () => {
    const { api, state } = buildSaveRecipe();
    await api.saveToRecipes();
    assert.equal(state.posts[0].url, '/p/save-recipe');
    assert.equal(state.posts[0].opts.method, 'POST');
    assert.deepEqual(JSON.parse(state.posts[0].opts.body), {});
    assert.equal(state.loads, 1);
    assert.deepEqual(state.renders, ['R']);
    assert.equal(state.toasts[0].msg, 'Saved as Turbo Ristretto');
});

test('saveToRecipes 409 says the slots are full and changes nothing', async () => {
    const { api, state } = buildSaveRecipe({ status: 409, json: { error: 'full', taken: [1, 2, 3, 4, 5] } });
    await api.saveToRecipes();
    assert.match(state.toasts[0].msg, /slots are full/);
    assert.equal(state.loads, 0);
    assert.deepEqual(state.renders, []);
});

test('saveToRecipes 404 tries an update once, then asks for one; other failures toast an error', async () => {
    let r = buildSaveRecipe({ status: 404 });
    await r.api.saveToRecipes();
    assert.equal(r.state.updates, 1);
    assert.equal(r.state.posts.length, 1);
    assert.equal(r.state.toasts[0].msg, 'Update DYE2 to save recipes');
    r = buildSaveRecipe({ status: 404, updated: true });
    await r.api.saveToRecipes();
    assert.equal(r.state.posts.length, 2, 'one retry, no loop');
    r = buildSaveRecipe({ status: 502 });
    await r.api.saveToRecipes();
    assert.equal(r.state.toasts[0].type, 'error');
});

// Legacy auto-save suppression: a depth counter, so overlapping applies keep the echo of the
// newest one from being written onto the previous item.
const suppressBody = lift([
    /async function withAutoSaveSuppressed\([\s\S]*?\r?\n\}/,
    /function flushPendingAutoSave\([\s\S]*?\r?\n\}/,
    /function clearActiveItem\([\s\S]*?\r?\n\}/,
    /function handleWorkflowUpdatedForAutoSave\([\s\S]*?\r?\n\}/,
]);

function buildSuppress() {
    const state = { saves: [] };
    const api = new Function(
        'AUTOSAVE_TARGETS', 'AUTOSAVE_DEBOUNCE_MS', 'isDye2Enabled', 'profileDrifted', 'saveItemFields', 'logger', 'state',
        `let activeItem = null, autoSaveSuppressDepth = 0, autoSaveTimer = null, autoSavePending = {}, dye2Armed = false;
         ${suppressBody}
         return {
           withAutoSaveSuppressed, handleWorkflowUpdatedForAutoSave,
           setActive: (item) => { activeItem = item; },
           active: () => activeItem, depth: () => autoSaveSuppressDepth,
         };`
    )(
        { recipe: { patch: (d) => ({ ...(d.context || {}) }) } },
        0,
        () => true,
        () => false,
        async (kind, id, fields) => { state.saves.push({ kind, id, fields }); },
        { error() {} },
        state,
    );
    return { api, state };
}

const tick = () => new Promise(r => setTimeout(r, 5));

test('overlapping applies keep suppression until the last one finishes', async () => {
    const { api } = buildSuppress();
    let releaseA, releaseB;
    const a = api.withAutoSaveSuppressed(() => new Promise(r => { releaseA = r; }));
    const b = api.withAutoSaveSuppressed(() => new Promise(r => { releaseB = r; }));
    assert.equal(api.depth(), 2);
    releaseA(); await a;
    assert.equal(api.depth(), 1, 'the second apply is still in flight');
    releaseB(); await b;
    assert.equal(api.depth(), 0);
});

test('a throwing apply still releases suppression', async () => {
    const { api } = buildSuppress();
    await assert.rejects(api.withAutoSaveSuppressed(async () => { throw new Error('boom'); }), /boom/);
    assert.equal(api.depth(), 0);
});

test('an echo during an overlapping apply writes nothing, and an apply drops the previous active item', async () => {
    const { api, state } = buildSuppress();
    api.setActive({ kind: 'recipe', id: 'prev' });
    let releaseA, releaseB;
    const a = api.withAutoSaveSuppressed(() => new Promise(r => { releaseA = r; }));
    assert.equal(api.active(), null, 'previous item is no longer the auto-save target');
    const b = api.withAutoSaveSuppressed(() => new Promise(r => { releaseB = r; }));
    releaseA(); await a;
    api.setActive({ kind: 'recipe', id: 'prev' }); // even if something re-set it, depth still blocks
    api.handleWorkflowUpdatedForAutoSave({}, { context: { targetDoseWeight: 18 } });
    await tick();
    assert.deepEqual(state.saves, []);
    releaseB(); await b;
    api.handleWorkflowUpdatedForAutoSave({}, { context: { targetDoseWeight: 18 } });
    await tick();
    assert.equal(state.saves.length, 1, 'once every apply is done, a tile edit saves again');
});

test('a pending debounced edit is flushed once to the OLD item before a new apply', async () => {
    const { api, state } = buildSuppress();
    api.setActive({ kind: 'recipe', id: 'old' });
    api.handleWorkflowUpdatedForAutoSave({}, { context: { targetDoseWeight: 18 } });
    let release;
    const a = api.withAutoSaveSuppressed(() => new Promise(r => { release = r; }));
    assert.equal(state.saves.length, 1);
    assert.equal(state.saves[0].id, 'old');
    assert.deepEqual(state.saves[0].fields, { targetDoseWeight: 18 });
    await new Promise(r => setTimeout(r, 80)); // the cancelled timer must not write again
    assert.equal(state.saves.length, 1);
    release(); await a;
});

test('an apply with nothing pending writes nothing', async () => {
    const { api, state } = buildSuppress();
    api.setActive({ kind: 'recipe', id: 'old' });
    await api.withAutoSaveSuppressed(async () => {});
    await new Promise(r => setTimeout(r, 80));
    assert.deepEqual(state.saves, []);
});

// ── A failed DYE2 read keeps what the strip already has ──────────────────────
import { keepPreviousOnFailure, resolveRecordsDialIn } from '../src/modules/dye-selection.js';

test('keepPreviousOnFailure: null (failed read) keeps previous, a real [] replaces it', () => {
    const prev = [{ id: 1 }];
    assert.equal(keepPreviousOnFailure(prev, null), prev);
    assert.equal(keepPreviousOnFailure(prev, undefined), prev);
    assert.deepEqual(keepPreviousOnFailure(prev, []), []);
    assert.deepEqual(keepPreviousOnFailure(prev, [{ id: 2 }]), [{ id: 2 }]);
});

test('resolveRecordsDialIn: unreadable plugin list keeps the previous capability', () => {
    const derive = (p) => p.length > 0;
    assert.equal(resolveRecordsDialIn(true, null, derive), true);
    assert.equal(resolveRecordsDialIn(false, null, derive), false);
    assert.equal(resolveRecordsDialIn(true, [], derive), false);
    assert.equal(resolveRecordsDialIn(false, [1], derive), true);
});

test('saveItemTopLevel throws instead of writing when the DYE2 read failed', async () => {
    const writes = [];
    const fn = new Function('RECIPES_KEY', 'AF_KEY', 'getDye2KvArray', 'setDye2KvArray', 'logger',
        `let recipeCache = [], favCache = []; ${body}\nreturn saveItemTopLevel;`)(
        'recipes', 'autoFavourites', async () => null, async (k, v) => writes.push([k, v]), { info() {} });
    await assert.rejects(() => fn('recipe', '1', { x: false }));
    assert.equal(writes.length, 0);
});
