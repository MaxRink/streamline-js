// What the Shot details dialog lists for one shot, as `{ label, value }` rows. DOM-free.
// Labels are translation keys; values are shot or plugin text and must be set as text.

export const E64_PLUGIN_ID = 'mahlkoenig-e64.reaplugin';

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
    ];
    return rows.filter(row => row.value !== null);
}

/**
 * The assisted dial-in plugin's answer for one shot, from `GET .../recommendations?shotId=`.
 * Accepts the single form and a batch (`{ recommendations: [...] | { <shotId>: ... } }` or an
 * array of entries carrying `shotId`). null when there is nothing for this shot.
 */
export function pickDialInRecommendation(body, shotId) {
    const id = String(shotId);
    const valid = entry => (entry && typeof entry === 'object' && typeof entry.status === 'string' ? entry : null);
    const list = Array.isArray(body) ? body : body?.recommendations ?? body?.items;
    if (Array.isArray(list)) return valid(list.find(entry => String(entry?.shotId) === id));
    if (list && typeof list === 'object') return valid(list[id]);
    if (body?.shotId !== undefined && String(body.shotId) !== id) return null;
    return valid(body?.recommendation) ?? valid(body);
}

export function dialInRecommendationRows(entry) {
    if (!entry) return [];
    const setting = text(entry.grinderSetting ?? entry.proposedSetting ?? entry.setting);
    const withUnit = setting ? joined([setting, text(entry.settingUnit)], ' ') : null;
    const direction = text(entry.direction);
    let value;
    if (entry.status === 'abstain') value = 'No recommendation';
    else if (withUnit && direction) value = `${withUnit} (${direction})`;
    else value = withUnit || direction;
    if (!value) return [];
    const warnings = Array.isArray(entry.warnings) ? entry.warnings.map(text).filter(Boolean) : [];
    return [
        { label: entry.status === 'suggestion' ? 'Suggested grind' : 'Recommended grind', value, translate: entry.status === 'abstain' },
        ...[text(entry.reason), ...warnings].filter(Boolean).map(note => ({ label: '', value: note })),
    ];
}
