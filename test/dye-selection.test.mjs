// Selection survives the full-page trip to DYE2 only while it is still true.
// Run: node --test test/dye-selection.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    profileFingerprint, profileDrifted, serializeSelection, restoreSelection,
    parseDyeReturn, resolveReturn, changedFields, pluginRecordsDialIn, armedSelectionId,
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

// ── scoped post-shot clean-up ──
import { scopedClearContext } from '../src/modules/dye-context.js';

test('scopedClearContext: only flagged, only present, flags go with the values', () => {
    assert.equal(scopedClearContext(null), null);
    assert.equal(scopedClearContext({ coffeeName: 'x' }), null, 'no marker: caller falls back');
    assert.equal(scopedClearContext({ coffeeName: 'x', extras: { dye: { v: 1 } } }), null);
    assert.deepEqual(
        scopedClearContext({ coffeeName: 'x', grinderModel: 'EG-1', extras: { rpm: 900, dye: { v: 1, coffeeName: true, rpm: true, note: true } } }),
        { coffeeName: null, extras: { rpm: null, dye: { coffeeName: null, rpm: null, note: null } } },
    );
    // an unknown flag is cleared as a flag only, never as a value
    assert.deepEqual(scopedClearContext({ profile: 'p', extras: { dye: { v: 1, profile: true } } }), { extras: { dye: { profile: null } } });
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
