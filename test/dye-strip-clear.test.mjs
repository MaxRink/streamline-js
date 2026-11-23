import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { profilePatchWithSteps } from '../src/modules/dye-selection.js';

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
        'PLUGIN_BASE', 'fetch', 'logger', 'showToast', 'recipeLabel', 'favLabel', 'loadDyeStripData', 'renderStrip', 'currentMode', 'updateDye2Now', 'syncSelection',
        `let activeModified = true;\n${saveBody}\nreturn { saveChanges, modified: () => activeModified };`
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
        async () => { state.syncs = (state.syncs || 0) + 1; return false; }, // DYE2's answer is covered in dye-strip-star.test.mjs
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
    assert.equal(api.modified(), false, 'the stale * is cleared after a save');
});

test('saveChanges with saved:false leaves the caches alone', async () => {
    const { api, state } = buildSave({ json: { saved: false } });
    await api.saveChanges('recipe', { id: '1', title: 'A' });
    assert.equal(state.loads, 0, 'nothing was written, so the caches are not reloaded');
    assert.equal(state.syncs, 1, 'but DYE2 is asked: saved:false can mean already saved');
    assert.equal(state.toasts[0].msg, 'No changes to save');
    assert.equal(api.modified(), true, 'the local flag is only changed by DYE2 answer');
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

// "Replace <name>" hands the slot to DYE2's recipe library rather than saving the live
// workflow: the barista picks a card there and it is assigned to the button they pressed.
// Saving the machine's state as a NEW recipe is still what a BLANK cell's menu does.
test('Replace opens the recipe picker targeted at the pressed slot; blank cells still save the live workflow', () => {
    const source = readFileSync(new URL('../src/modules/dyeStrip.js', import.meta.url), 'utf8');
    const menu = source.slice(source.indexOf('function openCellMenu('));
    const body = menu.slice(0, menu.indexOf('\n}\n'));
    assert.ok(/kind === 'recipe' && dye2HasSelectRecipe \? \[\{ label: `\$\{getTranslation\('Replace'\)\} \$\{recipeLabel\(item\)\}`, onSelect: \(\) => openPluginOverlay\('select-recipe', \{ slot \}\)/.test(body),
        'recipe cells only, names the recipe replaced, sends the slot to the picker, '
        + 'and only where the installed DYE2 serves that page');
    // Order-independent: the entry itself must not reach saveToRecipes at all. Bounded by its own
    // ternary, not by the divider -- "Save to recipes" is a later entry in the same window.
    const replaceEntry = body.slice(body.indexOf("getTranslation('Replace')"));
    assert.ok(!replaceEntry.slice(0, replaceEntry.indexOf('] : [])')).includes('saveToRecipes'),
        'Replace no longer writes the live workflow over the slot');
    assert.ok(body.indexOf("'Save changes'") < body.indexOf("'Replace'") && body.indexOf("'Replace'") < body.indexOf('divider'),
        'after Save changes, before the divider');
    assert.ok(!/'Replace'[\s\S]*dye2RecordsDialIn/.test(body), 'not gated on dial-in recording');
});

// An empty button can be filled two ways: from DYE2's library, or from what is on the machine.
// "Select recipe" reuses the assign flow -- it needs no recipe to already hold the slot.
test('a blank R cell offers Select recipe and Save to recipe, in that order', () => {
    const source = readFileSync(new URL('../src/modules/dyeStrip.js', import.meta.url), 'utf8');
    const blank = source.slice(source.indexOf("makeCell('', CELL_IDLE, () => editRecipe({ id: slot, blank: true })"));
    const body = blank.slice(0, blank.indexOf('return;'));

    assert.ok(/dye2HasSelectRecipe \? \[\{ label: getTranslation\('Select recipe'\), onSelect: \(\) => openPluginOverlay\('select-recipe', \{ slot \}\) \}\]/.test(body),
        'Select recipe opens the picker targeted at this empty slot, and is offered only '
        + 'where the installed DYE2 serves that page (an older one answers 404 in the overlay)');
    assert.ok(/\{ label: `\$\{getTranslation\('Save to recipe'\)\} \$\{slot\}`, onSelect: \(\) => saveToRecipes\(slot\) \}/.test(body),
        'Save to recipe still captures the live workflow into this slot');
    assert.ok(body.indexOf("'Select recipe'") < body.indexOf("'Save to recipe'"),
        'picking an existing recipe is the first option');
    assert.ok(!body.includes("'Clear button'"), 'nothing to clear on an empty cell');
    // A tap is still the blank new-recipe form, not the picker.
    assert.ok(body.includes('editRecipe({ id: slot, blank: true })'));
});

function buildSaveRecipe({ status = 200, json = { id: 'r1', name: 'Turbo Ristretto' }, updated = false } = {}) {
    const state = { toasts: [], loads: 0, renders: [], posts: [], updates: 0, syncs: 0 };
    const fnBody = lift([/async function saveToRecipes\([\s\S]*?\r?\n\}/]);
    const api = new Function(
        'PLUGIN_BASE', 'fetch', 'logger', 'showToast', 'loadDyeStripData', 'renderStrip', 'currentMode', 'updateDye2Now', 'syncSelection',
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
        async () => { state.syncs++; return false; },
    );
    return { api, state };
}

test('saveToRecipes posts the pressed slot, reloads, re-renders and toasts the returned name', async () => {
    const { api, state } = buildSaveRecipe();
    await api.saveToRecipes('4');
    assert.equal(state.posts[0].url, '/p/save-recipe');
    assert.equal(state.posts[0].opts.method, 'POST');
    assert.deepEqual(JSON.parse(state.posts[0].opts.body), { slot: 4 });
    assert.equal(state.loads, 1);
    assert.deepEqual(state.renders, ['R']);
    assert.equal(state.toasts[0].msg, 'Saved as Turbo Ristretto');
});

test('saveToRecipes 409 says the slots are full and changes nothing', async () => {
    const { api, state } = buildSaveRecipe({ status: 409, json: { error: 'full', taken: [1, 2, 3, 4, 5] } });
    await api.saveToRecipes('2');
    assert.match(state.toasts[0].msg, /slots are full/);
    assert.equal(state.loads, 0);
    assert.deepEqual(state.renders, []);
});

test('saveToRecipes 404 tries an update once, then asks for one; other failures toast an error', async () => {
    let r = buildSaveRecipe({ status: 404 });
    await r.api.saveToRecipes('1');
    assert.equal(r.state.updates, 1);
    assert.equal(r.state.posts.length, 1);
    assert.equal(r.state.toasts[0].msg, 'Update DYE2 to save recipes');
    r = buildSaveRecipe({ status: 404, updated: true });
    await r.api.saveToRecipes('1');
    assert.equal(r.state.posts.length, 2, 'one retry, no loop');
    assert.deepEqual(JSON.parse(r.state.posts[1].opts.body), { slot: 1 }, 'the retry keeps the slot');
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

// #159 acceptance 4: a favourite or recent has no save target of its own, so the only way to keep
// a dial-in from one is to make a recipe of it. No slot is sent -- the recipe lands in DYE2's
// library as a card, and the barista gives it a button there (or from a blank cell's menu).
test('a favourite cell offers Save to recipes, with no slot, and a recipe cell does not', () => {
    const source = readFileSync(new URL('../src/modules/dyeStrip.js', import.meta.url), 'utf8');
    const menu = source.slice(source.indexOf('function openCellMenu('));
    const body = menu.slice(0, menu.indexOf('\n}\n'));

    assert.ok(/kind === 'favourite' \? \[\{ label: getTranslation\('Save to recipes'\), onSelect: \(\) => saveToRecipes\(null, item\.beverage\) \}\] : \[\]/.test(body),
        'favourite cells only, translated, saveToRecipes(null) for a library-only save, and the item\'s own beverage');
    assert.ok(body.indexOf("'Save to recipes'") < body.indexOf('divider'), 'before the divider');
    // Not gated on dial-in recording: unlike "Save changes", this writes a new row rather than
    // asking DYE2 to record onto the selection, so an older DYE2 answers it too.
    assert.ok(!/'Save to recipes'[\s\S]*dye2RecordsDialIn/.test(body), 'not gated on dial-in recording');
});

test('saveToRecipes with no slot omits it, so DYE2 saves to the library', async () => {
    const { api, state } = buildSaveRecipe();
    await api.saveToRecipes(null);
    assert.deepEqual(JSON.parse(state.posts[0].opts.body), {}, 'no slot at all -- not slot: 0');
    assert.equal(state.loads, 1);
    assert.deepEqual(state.renders, ['R']);
});

// DYE2 names the recipe `<profile word> <bean> [beverage]` and never guesses a drink from the
// shot, so the only way a drink word reaches the name is the item's own typed beverage field --
// which lives on the KV row, not on the workflow, so DYE2 cannot read it back for itself.
test('saveToRecipes sends a typed beverage, and omits the field when there is none', async () => {
    let r = buildSaveRecipe();
    await r.api.saveToRecipes(null, 'Cappuccino');
    assert.deepEqual(JSON.parse(r.state.posts[0].opts.body), { beverage: 'Cappuccino' });

    r = buildSaveRecipe();
    await r.api.saveToRecipes('3', 'Flat White');
    assert.deepEqual(JSON.parse(r.state.posts[0].opts.body), { slot: 3, beverage: 'Flat White' },
        'a blank cell save carries it too');

    r = buildSaveRecipe();
    await r.api.saveToRecipes('3', '');
    assert.deepEqual(JSON.parse(r.state.posts[0].opts.body), { slot: 3 },
        'nothing typed: the field is absent, so DYE2 names from profile + bean alone');
});

test('the retry after a DYE2 update keeps the beverage', async () => {
    const { api, state } = buildSaveRecipe({ status: 404, updated: true });
    await api.saveToRecipes(null, 'Latte');
    assert.equal(state.posts.length, 2, 'one retry');
    assert.deepEqual(JSON.parse(state.posts[1].opts.body), { beverage: 'Latte' },
        'the retried POST is not a bare one -- the third arg is the retried flag, not the beverage');
});

// save-recipe arms the new recipeId in the workflow, so the new recipe is the selected item.
// Without this the strip keeps highlighting the favourite it was saved from until the next repoll.
test('saveToRecipes takes DYE2 derived selection so the new recipe highlights at once', async () => {
    const { api, state } = buildSaveRecipe();
    await api.saveToRecipes(null);
    assert.equal(state.syncs, 1);
    const sync = readFileSync(new URL('../src/modules/dyeStrip.js', import.meta.url), 'utf8')
        .match(/async function saveToRecipes\([\s\S]*?\r?\n\}/)[0];
    assert.ok(sync.includes('syncSelection({ mirror: false })'), 'the derived route only, never the stale mirror');
    assert.ok(sync.indexOf('loadDyeStripData') < sync.indexOf('syncSelection'),
        'caches first: armedSelectionId resolves the new id against them');
});

// ── What an apply patches as its profile ────────────────────────────────────
// PUT /workflow deep-merges, so a profile without steps renames the loaded one
// instead of replacing it: the machine keeps the previous curve under the item's
// name. An unresolvable profile must therefore drop out of the patch. The trap
// is the other direction -- a DYE2 row that captured the whole profile stores
// Decaid's `workflow.profile`, which carries NO id, so resolving the id first
// threw away every fully-captured recipe and the apply sent no profile at all.
const resolveBody = lift([
    /async function resolveFullProfile\([\s\S]*?\r?\n\}/,
    /async function applyStoredWorkflow\([\s\S]*?\r?\n\}/,
    /async function applyFavLegacy\([\s\S]*?\r?\n\}/,
    /async function applyRecipeLegacy\([\s\S]*?\r?\n\}/,
]);

const fullProfile = { version: '2', title: 'Advanced spring lever test', steps: [{ name: 'fill' }, { name: 'pour' }] };

function buildApply({ library = [], fail = false } = {}) {
    const state = { warnings: [], fetches: 0 };
    return new Function(
        'getProfiles', 'logger', 'profilePatchWithSteps', 'state',
        `${resolveBody}
         return { resolveFullProfile, applyStoredWorkflow, applyFavLegacy, applyRecipeLegacy };`
    )(
        async () => { state.fetches++; if (fail) throw new Error('bridge down'); return library; },
        { warn: (m) => state.warnings.push(m), info() {}, error() {} },
        profilePatchWithSteps, // the real helper, not a stand-in that could drift from it
        state,
    );
}

test('a recipe that captured the whole profile is sent as-is, id or no id', async () => {
    const api = buildApply();
    // Decaid's workflow.profile: full steps, no id anywhere.
    assert.deepEqual(await api.resolveFullProfile(fullProfile), fullProfile);
    const patch = await api.applyStoredWorkflow({ context: { targetDoseWeight: 19 }, profile: fullProfile });
    assert.deepEqual(patch.profile, fullProfile, 'the captured profile reaches the patch');
    assert.deepEqual(patch.context, { targetDoseWeight: 19 });
});

test('a profile that cannot be resolved leaves the loaded one alone', async () => {
    const api = buildApply({ library: [{ id: 'profile:abc', profile: fullProfile }] });
    // The thin stub DYE2 rows hold: resolvable by id.
    assert.deepEqual(await api.resolveFullProfile({ id: 'profile:abc', title: 'Advanced spring lever test' }), fullProfile);
    // Unresolvable, and a `steps: []` row, and a bare {}: no profile in the patch at all.
    for (const stored of [{ id: 'profile:gone', title: 'Cremina&Gusto' }, { id: 'profile:gone', title: 'X', steps: [] }, {}]) {
        const patch = await api.applyStoredWorkflow({ context: { targetYield: 95 }, profile: stored });
        assert.ok(!('profile' in patch), `a stepless profile must not be patched: ${JSON.stringify(stored)}`);
        assert.deepEqual(patch.context, { targetYield: 95 }, 'the rest of the apply still lands');
    }
    // A bridge that simply failed is the same answer, never a throw.
    const down = buildApply({ fail: true });
    assert.equal(await down.resolveFullProfile({ id: 'profile:abc', title: 'A' }), null);
});

test('the legacy favourite and recipe paths follow the same rule', async () => {
    const api = buildApply({ library: [{ id: 'profile:abc', profile: fullProfile }] });

    const favSnapshot = await api.applyFavLegacy({ snapshot: { profileSnapshot: fullProfile, profileId: 'profile:gone' } });
    assert.deepEqual(favSnapshot.profile, fullProfile, 'a captured snapshot wins');
    // A `steps: []` snapshot is not full: fall through to the stored id rather than patching it.
    const favFallThrough = await api.applyFavLegacy({ snapshot: { profileSnapshot: { title: 'A', steps: [] }, profileId: 'profile:abc' } });
    assert.deepEqual(favFallThrough.profile, fullProfile);
    const favGone = await api.applyFavLegacy({ snapshot: { dose: 18, profileId: 'profile:gone', profileTitle: 'Cremina&Gusto' } });
    assert.ok(!('profile' in favGone), 'no steps anywhere means no profile patch');
    assert.equal(favGone.context.targetDoseWeight, 18, 'the dial still applies');

    const recipeGone = await api.applyRecipeLegacy({
        dashboardVariables: { dose: 19, drink: 95 }, profileId: 'profile:gone', profileTitle: 'Cremina&Gusto',
    });
    assert.ok(!('profile' in recipeGone));
    assert.deepEqual(recipeGone.context, { targetDoseWeight: 19, targetYield: 95 });
    const recipeOk = await api.applyRecipeLegacy({ dashboardVariables: {}, profileSnapshot: fullProfile, profileId: 'profile:gone' });
    assert.deepEqual(recipeOk.profile, fullProfile);
});
