// What the Shot details dialog lists for one shot, as `{ label, value }` rows. DOM-free.
// Labels are translation keys; values are shot or plugin text and must be set as text.

export const E64_PLUGIN_ID = 'mahlkoenig-e64.reaplugin';
export const DIALIN_PLUGIN_ID = 'assisted-dialin.reaplugin';

const text = value => (typeof value === 'string' && value.trim() ? value.trim()
    : Number.isFinite(value) ? String(value) : null);
const joined = (parts, separator) => parts.filter(Boolean).join(separator) || null;
const grams = n => (Number.isFinite(n) ? `${Number(n.toFixed(1))} g` : null);

function lastGrindText(extras) {
    const grind = extras?.[E64_PLUGIN_ID]?.lastGrind;
    if (!grind || typeof grind !== 'object') return null;
    const result = grams(grind.resultWeightGr);
    const target = grams(grind.targetWeightGr);
    const weight = result && target ? `${result} / ${target}` : result || target;
    const seconds = Number.isFinite(grind.motorRunTimeMs) ? `${Number((grind.motorRunTimeMs / 1000).toFixed(1))} s` : null;
    return joined([weight, seconds, text(grind.mode)], ' · ');
}

export function shotDetailRows(shot) {
    const context = shot?.workflow?.context ?? {};
    const extras = context.extras && typeof context.extras === 'object' ? context.extras : null;
    const e64 = extras?.[E64_PLUGIN_ID];
    const display = text(e64?.displayedSetting);
    const setting = text(context.grinderSetting ?? shot?.workflow?.grinderData?.setting);
    const rows = [
        { label: 'Coffee', value: joined([text(context.coffeeRoaster), text(context.coffeeName)], ' · ') },
        { label: 'Grinder', value: joined([text(context.grinderModel), text(context.grinderBurrs)], ' · ') },
        { label: 'Grind setting', value: setting },
        { label: 'Grinder display', value: display && display !== setting ? joined([display, text(e64?.unit)], ' ') : null },
        { label: 'Last grind', value: lastGrindText(extras) },
        { label: 'Advice before this shot', value: text(extras?.[DIALIN_PLUGIN_ID]?.recommendation?.message) },
    ];
    return rows.filter(row => row.value !== null);
}

/**
 * The assisted dial-in plugin's recommendation for one shot (0.8.0:
 * `GET recommendations?shotId=` -> `{ shotId, recommendation }`, `?shotIds=` ->
 * `{ recommendations: { <id>: ... } }`, no query -> `{ latest: [{ shotId, recommendation }] }`).
 * A bare entry or a list of entries carrying `shotId` is read too. null when there is none.
 */
export function pickDialInRecommendation(body, shotId) {
    const id = String(shotId);
    const valid = entry => {
        const candidate = entry?.recommendation !== undefined ? entry.recommendation : entry;
        return candidate && typeof candidate === 'object' && typeof candidate.status === 'string' ? candidate : null;
    };
    const list = Array.isArray(body) ? body : body?.recommendations ?? body?.latest;
    if (Array.isArray(list)) return valid(list.find(entry => String(entry?.shotId) === id));
    if (list && typeof list === 'object') return valid(list[id]);
    if (body?.shotId !== undefined && String(body.shotId) !== id) return null;
    return valid(body);
}

export function dialInRecommendationRows(entry) {
    if (!entry) return [];
    const message = text(entry.message);
    const notes = [text(entry.reason), message, ...(Array.isArray(entry.warnings) ? entry.warnings.map(text) : [])]
        .filter((note, index, all) => note && all.indexOf(note) === index);
    let row;
    if (entry.status === 'suggestion' || entry.status === 'recommendation') {
        const setting = text(entry.grinderSetting ?? entry.proposedSetting) ?? text(entry.proposedPreset);
        const withUnit = setting && entry.proposedPreset == null ? joined([setting, text(entry.settingUnit)], ' ') : setting;
        const direction = text(entry.direction);
        const value = withUnit && direction ? `${withUnit} (${direction})` : withUnit || direction;
        if (value) row = { label: entry.status === 'suggestion' ? 'Suggested grind' : 'Recommended grind', value, translate: false };
    } else {
        row = { label: 'Suggested grind', value: 'No recommendation', translate: true };
    }
    if (!row) return message ? [{ label: 'Suggested grind', value: message, translate: false }] : [];
    return [row, ...notes.map(note => ({ label: '', value: note }))];
}
