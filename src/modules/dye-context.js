// Post-shot clean-up of the workflow context, scoped to what DYE2 wrote.
// DOM-free so node:test can import it.
//
// DYE2 (>= DYE_MARKER_VERSION) records the fields it sets in
// context.extras.dye = { v: 1, <field>: true, ... }. Clearing only those leaves a
// coffee, grinder or rpm another plugin (or the user) set on purpose for every
// next shot. Older DYE2 has no marker, and the caller clears everything as before.

export const DYE_MARKER_VERSION = '0.1.20';

const TOP = ['beanBatchId', 'coffeeName', 'coffeeRoaster', 'grinderId', 'grinderModel', 'baristaName', 'drinkerName'];
const EXTRAS = ['basketId', 'basketName', 'rpm', 'note'];

/** Did a DYE2 that marks its writes produce this context? */
export function hasDyeMarker(context) {
    const marker = context?.extras?.dye;
    return !!marker && typeof marker === 'object';
}

/**
 * The context payload that clears what DYE2 flagged, or null when nothing is
 * flagged. Values another writer set are untouched; the flags go with the values
 * so the next shot starts unclaimed.
 */
export function scopedClearContext(context) {
    const marker = context?.extras?.dye;
    if (!marker || typeof marker !== 'object') return null;
    const flagged = Object.keys(marker).filter(k => k !== 'v' && marker[k] === true);
    if (flagged.length === 0) return null;
    const extras = context.extras || {};
    const out = { extras: { dye: {} } };
    for (const k of flagged) {
        if (TOP.includes(k)) { if (context[k] != null) out[k] = null; }
        else if (EXTRAS.includes(k)) { if (extras[k] != null) out.extras[k] = null; }
        out.extras.dye[k] = null;
    }
    return out;
}
