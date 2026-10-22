// Selection survives the full-page trip to DYE2 only while it is still true.
// Run: node --test test/dye-selection.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    profileFingerprint, profileDrifted, serializeSelection, restoreSelection,
    parseDyeReturn, resolveReturn, changedFields, pluginRecordsDialIn, armedSelectionId, selectedRecipeSteamTemp, recipeStripCells, favStripCells,
} from '../src/modules/dye-selection.js';

const profile = { title: 'Londinium', target_weight: 36, steps: [{ name: 'fill', temperature: 90 }, { name: 'pour', temperature: 92 }] };
const item = { kind: 'recipe', id: '2', profileId: null, profileFingerprint: profileFingerprint(profile) };
const ctx = { recipes: [{ id: '1' }, { id: '2' }], favs: [{ id: 7 }], workflow: { profile } };

test('brew-temperature edits are not drift, a profile switch is', () => {
    const warmer = { ...profile, steps: profile.steps.map(s => ({ ...s, temperature: 95 })) };
    assert.equal(profileDrifted(item, { profile: warmer }), false);
    assert.equal(profileDrifted(item, { profile: { ...profile, title: 'Blooming' } }), true);
    assert.equal(profileDrifted(item, { profile: { ...profile, id: 'x' }, }), false); // item has no id to compare
    assert.equal(profileDrifted({ ...item, profileId: 'a' }, { profile: { ...profile, id: 'b' } }), true);
    assert.equal(profileDrifted(null, { profile }), false);
});

test('a yield change folded into target_weight/target_volume is not drift (#147)', () => {
    assert.equal(profileDrifted(item, { profile: { ...profile, target_weight: 42, target_volume: 50 } }), false);
});

test('serialize keeps only the four fields and refuses junk', () => {
    assert.deepEqual(JSON.parse(serializeSelection({ ...item, extra: 1 })), item);
    assert.equal(serializeSelection(null), null);
    assert.equal(serializeSelection({ kind: 'other', id: 1 }), null);
    assert.equal(serializeSelection({ kind: 'recipe', id: null }), null);
});

test('restore: round trip re-arms the same item', () => {
    assert.deepEqual(restoreSelection(serializeSelection(item), ctx), item);
});

test('restore: favourites resolve against favs, ids compared as strings', () => {
    const fav = { kind: 'favourite', id: 7, profileId: null, profileFingerprint: item.profileFingerprint };
    assert.deepEqual(restoreSelection(serializeSelection(fav), ctx), fav);
    assert.equal(restoreSelection(serializeSelection({ ...item, id: 2 }), ctx).id, 2);
});

test('restore: discarded when deleted, drifted, or unreadable', () => {
    assert.equal(restoreSelection(serializeSelection({ ...item, id: '9' }), ctx), null);
    assert.equal(restoreSelection(serializeSelection(item), { ...ctx, workflow: { profile: { ...profile, title: 'Other' } } }), null);
    assert.equal(restoreSelection('{not json', ctx), null);
    assert.equal(restoreSelection('null', ctx), null);
    assert.equal(restoreSelection(serializeSelection(item), { ...ctx, recipes: undefined }), null);
});

test('return param: absent means an older DYE2, empty means nothing applied', () => {
    assert.deepEqual(parseDyeReturn(''), { supported: false });
    assert.deepEqual(parseDyeReturn('?_=1'), { supported: false });
    assert.deepEqual(parseDyeReturn('?dyeApplied='), { supported: true, applied: 'none' });
    assert.deepEqual(parseDyeReturn('?dyeApplied=recipe:2'), { supported: true, applied: 'item', kind: 'recipe', id: '2' });
    assert.deepEqual(parseDyeReturn('?dyeApplied=favourite:af-7'), { supported: true, applied: 'item', kind: 'favourite', id: 'af-7' });
    assert.deepEqual(parseDyeReturn('?dyeApplied=other'), { supported: true, applied: 'other' });
    assert.deepEqual(parseDyeReturn('?dyeApplied=bogus'), { supported: true, applied: 'other' });
});

test('resolveReturn: only a DYE2 that vouches for its applies may write back', () => {
    const parked = serializeSelection(item);
    const none = { supported: true, applied: 'none' };
    const old = { supported: false };
    // edited in DYE, nothing applied: keep the parked item and fold
    assert.deepEqual(resolveReturn({ parked, ret: none, ...ctx }), { item, fold: true });
    // older DYE2: keep the highlight, never write
    assert.deepEqual(resolveReturn({ parked, ret: old, ...ctx }), { item, fold: false });
    // DYE2 applied another recipe: that one is armed, fresh against the live profile
    const b = resolveReturn({ parked, ret: { supported: true, applied: 'item', kind: 'recipe', id: '1' }, ...ctx });
    assert.equal(b.item.id, '1');
    assert.equal(b.item.profileFingerprint, profileFingerprint(profile));
    assert.equal(b.fold, true);
    // applied something with no stable id, or an item that is gone: nothing armed
    assert.deepEqual(resolveReturn({ parked, ret: { supported: true, applied: 'other' }, ...ctx }), { item: null, fold: false });
    assert.deepEqual(resolveReturn({ parked, ret: { supported: true, applied: 'item', kind: 'recipe', id: '9' }, ...ctx }), { item: null, fold: false });
    // no parked item and nothing applied: nothing to do
    assert.deepEqual(resolveReturn({ parked: null, ret: none, ...ctx }), { item: null, fold: false });
    // a profile switched inside DYE discards the parked item
    const switched = { ...ctx, workflow: { profile: { ...profile, title: 'Other' } } };
    assert.deepEqual(resolveReturn({ parked, ret: none, ...switched }), { item: null, fold: false });
});

test('changedFields: only real differences, numeric strings compare equal', () => {
    assert.deepEqual(changedFields({ dose: 18, drink: 40, grind: 21.5 }, { dose: 18, drink: '40', grind: 20 }), { grind: 21.5 });
    assert.deepEqual(changedFields({ dose: 18 }, undefined), { dose: 18 });
    assert.deepEqual(changedFields({}, { dose: 1 }), {});
});

test('pluginRecordsDialIn: only a loaded DYE2 that declares the selection endpoint', () => {
    const api = [{ type: 'http', id: 'dashboard' }, { type: 'http', id: 'selection' }, { type: 'websocket', id: 'changed' }];
    assert.equal(pluginRecordsDialIn([{ id: 'dye2.reaplugin', loaded: true, api }]), true);
    // an older DYE2: no such endpoint, so the skin keeps its own auto-save
    assert.equal(pluginRecordsDialIn([{ id: 'dye2.reaplugin', loaded: true, api: [{ type: 'http', id: 'dashboard' }] }]), false);
    assert.equal(pluginRecordsDialIn([{ id: 'dye2.reaplugin', loaded: false, api }]), false);
    // a websocket of the same name is not the endpoint we POST to
    assert.equal(pluginRecordsDialIn([{ id: 'dye2.reaplugin', loaded: true, api: [{ type: 'websocket', id: 'selection' }] }]), false);
    assert.equal(pluginRecordsDialIn([{ id: 'other.reaplugin', loaded: true, api }]), false);
    // unreachable bridge / junk: fall back to the skin's own auto-save, never throw
    assert.equal(pluginRecordsDialIn(null), false);
    assert.equal(pluginRecordsDialIn([]), false);
    assert.equal(pluginRecordsDialIn([{ id: 'dye2.reaplugin', loaded: true }]), false);
});

test('armedSelectionId: the cached item own id, or null when it is gone', () => {
    const lists = { recipes: [{ id: '2' }], favs: [{ id: 7 }] };
    assert.equal(armedSelectionId({ kind: 'recipe', id: '2' }, lists), '2');
    // ids compare as strings but the cached item's own type is returned, since the
    // highlight is compared strictly against it
    assert.equal(armedSelectionId({ kind: 'favourite', id: '7' }, lists), 7);
    assert.equal(armedSelectionId({ kind: 'recipe', id: '9' }, lists), null);
    assert.equal(armedSelectionId({ kind: 'other', id: '2' }, lists), null);
    assert.equal(armedSelectionId(null, lists), null);
    assert.equal(armedSelectionId({ kind: 'recipe' }, lists), null);
    assert.equal(armedSelectionId({ kind: 'recipe', id: '2' }, { recipes: undefined, favs: [] }), null);
});

test('profileFingerprint: limiter {value:0}, null and absent hash the same; a real limit differs', () => {
    const withLimiter = limiter => ({ ...profile, steps: [{ name: 'fill', temperature: 90, ...(limiter === undefined ? {} : { limiter }) }] });
    const missing = profileFingerprint(withLimiter(undefined));
    assert.equal(profileFingerprint(withLimiter({ value: 0, range: 0.6 })), missing);
    assert.equal(profileFingerprint(withLimiter(null)), missing);
    assert.notEqual(profileFingerprint(withLimiter({ value: 1.5, range: 0.6 })), missing);
});

test('profileDrifted: an item fingerprinted with a 0 limiter does not drift against a null limiter', () => {
    const zero = { ...profile, steps: [{ name: 'fill', limiter: { value: 0, range: 0.6 } }] };
    const none = { ...profile, steps: [{ name: 'fill', limiter: null }] };
    assert.equal(profileDrifted({ profileFingerprint: profileFingerprint(zero) }, { profile: none }), false);
});

test('armedSelectionId: an empty selection object arms nothing', () => {
    assert.equal(armedSelectionId({}, { recipes: [{ id: '1' }], favs: [{ id: 7 }] }), null);
});

test('selectedRecipeSteamTemp: the selected recipe steam temperature, or null', () => {
    const recipes = [{ id: '2', dashboardVariables: { steamTempC: 140.4 } }, { id: '3', dashboardVariables: { steamTempC: 0 } }, { id: '4' }];
    assert.equal(selectedRecipeSteamTemp({ kind: 'recipe', id: 2 }, recipes), 140);
    assert.equal(selectedRecipeSteamTemp({ kind: 'recipe', id: '3' }, recipes), null, 'below 135 is off, not a temperature');
    assert.equal(selectedRecipeSteamTemp({ kind: 'recipe', id: '4' }, recipes), null);
    assert.equal(selectedRecipeSteamTemp({ kind: 'recipe', id: '9' }, recipes), null);
    assert.equal(selectedRecipeSteamTemp({ kind: 'favourite', id: '2' }, recipes), null);
    assert.equal(selectedRecipeSteamTemp(null, recipes), null);
    assert.equal(selectedRecipeSteamTemp({ kind: 'recipe', id: '2' }, null), null);
});

const recipeIds = cells => cells.map(c => c.recipe && String(c.recipe.id));

test('recipeStripCells places each recipe at its id slot whatever the KV order', () => {
    const cells = recipeStripCells([{ id: '3' }, { id: 1 }]);
    assert.deepEqual(cells.map(c => c.slot), ['1', '2', '3', '4', '5']);
    assert.deepEqual(recipeIds(cells), ['1', null, '3', null, null]);
});

test('recipeStripCells leaves a hidden recipe as a blank and moves nothing', () => {
    const recipes = [1, 2, 3, 4, 5].map(id => ({ id: String(id), showOnStreamlineDashboard: id === 2 ? false : undefined }));
    assert.deepEqual(recipeIds(recipeStripCells(recipes)), ['1', null, '3', '4', '5']);
});

test('recipeStripCells gives five blanks for null or garbage input', () => {
    for (const bad of [null, undefined, 'x', {}, [null, 7, 'a']]) {
        assert.deepEqual(recipeIds(recipeStripCells(bad)), [null, null, null, null, null]);
    }
});

test('recipeStripCells puts an out-of-range id into the first blank, and a duplicate id once', () => {
    assert.deepEqual(recipeIds(recipeStripCells([{ id: 'x' }, { id: '1' }, { id: '3' }])), ['1', 'x', '3', null, null]);
    const dup = recipeStripCells([{ id: '2', title: 'first' }, { id: '2', title: 'second' }]);
    assert.equal(dup[1].recipe.title, 'first');
    assert.equal(dup.filter(c => c.recipe).length, 1, 'the duplicate is dropped, not placed twice');
});

test('favStripCells sorts by favSlot then capturedAt', () => {
    const cells = favStripCells([
        { id: 'c', capturedAt: '2' },
        { id: 'b', capturedAt: '1' },
        { id: 'a', favSlot: 1, capturedAt: '9' },
    ]);
    assert.deepEqual(cells.map(c => c.fav.id), ['a', 'b', 'c']);
    assert.ok(cells.every(c => c.hidden === null));
});

test('favStripCells keeps a hidden favourite as a gap and shifts nothing', () => {
    const favs = ['a', 'b', 'c', 'd', 'e'].map((id, i) => ({ id, favSlot: i, alwaysOnDashboard: id === 'b' ? false : undefined }));
    const cells = favStripCells(favs);
    assert.equal(cells.length, 4);
    assert.deepEqual(cells.map(c => c.fav && c.fav.id), ['a', null, 'c', 'd']);
    assert.equal(cells[1].hidden.id, 'b');
});

test('favStripCells does not back-fill from beyond max, and handles short or empty lists', () => {
    const favs = [{ id: 'a', favSlot: 0, alwaysOnDashboard: false }, { id: 'b', favSlot: 1 }, { id: 'c', favSlot: 2 }, { id: 'd', favSlot: 3 }, { id: 'e', favSlot: 4 }];
    assert.deepEqual(favStripCells(favs).map(c => c.fav && c.fav.id), [null, 'b', 'c', 'd']);
    assert.equal(favStripCells([{ id: 'a' }, { id: 'b' }]).length, 2);
    assert.deepEqual(favStripCells([]), []);
    assert.deepEqual(favStripCells(null), []);
});
