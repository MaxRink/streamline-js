// Which DYE strip recipe / favourite is being dialled in, and whether that
// selection is still true. DOM-free so node:test can import it.
//
// The selection lives in module memory in dyeStrip.js, but on Decaid the DYE
// button navigates the whole page away (skin and plugin differ in origin), so a
// return from DYE reloads the skin. The selection is parked in sessionStorage
// across that trip and re-validated here on the way back.

export const SELECTION_KEY = 'streamline.dyeSelection';

// Decaid's workflow.profile carries no `id` (confirmed on 0.8.6+2801: a PUT's
// profile.id is dropped, and the next GET has none either), so the id check in
// profileDrifted never actually fires and the profile-drift guard silently never
// fired either -- see decentespresso/streamline-js#90. This fingerprints the
// fields a real profile switch changes and a recipe's own brew-temp auto-save
// does not: `updateTemperatureValue()` PUTs the same profile back with only
// `steps[*].temperature` edited, so temperature is stripped before hashing --
// otherwise every brew-temp tweak would look like switching to a new profile
// and immediately clear the item auto-save is running for.
export function profileFingerprint(profile) {
    if (!profile) return null;
    const steps = Array.isArray(profile.steps)
        ? profile.steps.map(({ temperature, ...rest }) => rest)
        : profile.steps;
    return JSON.stringify({
        title: profile.title,
        target_weight: profile.target_weight,
        target_volume: profile.target_volume,
        tank_temperature: profile.tank_temperature,
        steps,
    });
}

/** Has the live workflow's profile moved away from the one `item` was armed on? */
export function profileDrifted(item, workflow) {
    if (!item) return false;
    const profileId = workflow?.profile?.id;
    const fingerprint = profileFingerprint(workflow?.profile);
    const idDrifted = !!(item.profileId && profileId && profileId !== item.profileId);
    const fingerprintDrifted = !!(item.profileFingerprint && fingerprint && fingerprint !== item.profileFingerprint);
    return idDrifted || fingerprintDrifted;
}

/** The slice of the active item worth carrying across a reload. */
export function serializeSelection(item) {
    if (!item || item.id == null || (item.kind !== 'recipe' && item.kind !== 'favourite')) return null;
    return JSON.stringify({
        kind: item.kind,
        id: item.id,
        profileId: item.profileId ?? null,
        profileFingerprint: item.profileFingerprint ?? null,
    });
}

/**
 * Decide whether a parked selection survives. Returns the item to re-arm, or
 * null to discard: unparseable, the recipe/favourite is gone, or the workflow's
 * profile no longer matches (the barista changed profile inside DYE).
 */
export function restoreSelection(raw, { recipes, favs, workflow }) {
    let saved;
    try { saved = JSON.parse(raw); } catch { return null; }
    if (!saved || saved.id == null) return null;
    const list = saved.kind === 'recipe' ? recipes : saved.kind === 'favourite' ? favs : null;
    if (!Array.isArray(list)) return null;
    if (!list.some(x => x && String(x.id) === String(saved.id))) return null;
    if (profileDrifted(saved, workflow)) return null;
    return {
        kind: saved.kind,
        id: saved.id,
        profileId: saved.profileId ?? null,
        profileFingerprint: saved.profileFingerprint ?? null,
    };
}
