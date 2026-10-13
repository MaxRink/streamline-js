// plugin-surfaces.js -- parse and validate a plugin's `skin` answer
// (GET /api/v1/plugins/{id}/skin). DOM-free so node:test can import it.
//
// The answer is untrusted: a plugin installs from an arbitrary repo. Nothing here
// is trusted or executed; the output is plain, length-capped data that a renderer
// writes with textContent. Anything that does not validate is dropped, never
// repaired into something else, so a bad surface cannot break a good one.

export const SKIN_VERSION = 1;
export const MAX_SURFACES = 3;      // per plugin, all kinds together

export const TILES = ['dose', 'drink', 'grind', 'temperature'];
// The fields `set` may write. Each maximum is the one the tile itself enforces when
// the user types a value (ui.js makeEditable handlers; brew temperature also caps
// the +/- buttons at 105). The tile's minimum is 0; dose, yield and brew
// temperature use a higher minimum here (grind is the same 0).
// brewTemperature is in degrees Celsius. Applying it sets every step of the
// profile to that one value (the tile's own behaviour), flattening a profile
// that has temperature steps; see docs/plugin-surfaces.md.
export const SET_LIMITS = {
    targetDoseWeight: { min: 1, max: 30 },
    targetYield: { min: 1, max: 2000 },
    grinderSetting: { min: 0, max: 9999 },
    brewTemperature: { min: 70, max: 105 },
};
export const SET_FIELDS = Object.keys(SET_LIMITS);
export const PRESENTATIONS = ['page', 'overlay'];

// `tile-mode` adds an option to the toggle under a left-column tile's label.
// Steam and flush can take a mode but not a hint or a line, so they are not in TILES.
export const MODE_TILES = [...TILES, 'steam', 'flush'];
export const MODE_LIMITS = {
    label: 6,        // characters in the toggle option
    unit: 3,         // characters appended to the value
    presets: 4,      // the preset row has four slots
    bound: 9999,     // |min|, |max|
    decimals: 2,
};
const FIELD_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const CAPS = { label: 24, text: 40, hint: 24, title: 80, image: 2048 };

function cleanText(value, max) {
    if (typeof value !== 'string') return '';
    // eslint-disable-next-line no-control-regex
    return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

function httpsUrl(value) {
    if (typeof value !== 'string' || value.length > CAPS.image) return null;
    try {
        const u = new URL(value);
        if (u.protocol !== 'https:' || u.username || u.password) return null;
        return u.href;
    } catch {
        return null;
    }
}

// `overlay` is accepted but only a hint; the renderer decides what it can honour.
// Anything unknown falls back to `page` and never invalidates the surface.
function parseOpen(action) {
    const view = typeof action.view === 'string' ? action.view : '';
    return {
        type: 'open',
        view: ID_RE.test(view) ? view : '',
        presentation: PRESENTATIONS.includes(action.presentation) ? action.presentation : 'page',
    };
}

// A finite number from a number or a numeric string; null otherwise.
function toNumber(value) {
    const n = typeof value === 'number' ? value
        : (typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN);
    return Number.isFinite(n) ? n : null;
}

const round2 = n => Math.round(n * 100) / 100;

// A finite number (or numeric string) clamped to the field's range, to
// hundredths; null when it is not a number or the field is not settable.
export function clampSetValue(field, value) {
    if (!Object.prototype.hasOwnProperty.call(SET_LIMITS, field)) return null;
    const limits = SET_LIMITS[field];
    const n = toNumber(value);
    if (n === null) return null;
    return round2(Math.min(limits.max, Math.max(limits.min, n)));
}

function parseSet(action) {
    const value = clampSetValue(action.field, action.value);
    return value === null ? null : { type: 'set', field: action.field, value };
}

// `call` POSTs `{ [field]: <number> }` to one of the plugin's own http endpoints.
// Whether `endpoint` is one the plugin declares is checked against its manifest by
// callableEndpoint(); `skin` is the read side and is never callable.
function parseCall(action) {
    const { endpoint, field } = action;
    if (typeof endpoint !== 'string' || !ID_RE.test(endpoint) || endpoint === 'skin') return null;
    if (typeof field !== 'string' || !FIELD_RE.test(field)) return null;
    return { type: 'call', endpoint, field };
}

// True when `plugin` declares an http endpoint with this id that a `call` may use.
export function callableEndpoint(plugin, endpoint) {
    if (typeof endpoint !== 'string' || endpoint === 'skin') return false;
    return Array.isArray(plugin?.api) && plugin.api.some(e => e?.type === 'http' && e?.id === endpoint);
}

// An invalid action drops the action only; the surface still shows, inert.
// (`tile-mode` is the exception: without a valid `call` it is dropped.)
function parseAction(raw, kind) {
    if (!raw || typeof raw !== 'object') return null;
    if (raw.type === 'open') return parseOpen(raw);
    if (raw.type === 'set' && (kind === 'tile-hint' || kind === 'tile-line')) return parseSet(raw);
    if (raw.type === 'call' && kind === 'tile-mode') return parseCall(raw);
    return null;
}

// A mode the user steps through with the tile's -/+ and numpad. Every number is
// clamped into [min, max]; a mode that cannot be stepped or called is dropped.
function parseMode(raw, id, action) {
    if (!MODE_TILES.includes(raw.tile) || action?.type !== 'call') return null;
    const label = cleanText(raw.label, MODE_LIMITS.label);
    if (!label) return null;
    const unit = cleanText(raw.unit, MODE_LIMITS.unit);

    const bound = MODE_LIMITS.bound;
    const min = toNumber(raw.min);
    const max = toNumber(raw.max);
    if (min === null || max === null || min >= max || min < -bound || max > bound) return null;
    const clamp = n => round2(Math.min(max, Math.max(min, n)));

    const value = toNumber(raw.value);
    if (value === null) return null;
    const rawStep = raw.step == null ? 1 : toNumber(raw.step);
    if (rawStep === null || rawStep <= 0 || rawStep > max - min) return null;
    const decimals = raw.decimals == null ? 0 : raw.decimals;
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > MODE_LIMITS.decimals) return null;

    const presets = [];
    if (Array.isArray(raw.presets)) {
        for (const item of raw.presets) {
            const n = toNumber(item);
            if (n !== null && presets.length < MODE_LIMITS.presets) presets.push(clamp(n));
        }
    }
    return { id, kind: 'tile-mode', tile: raw.tile, label, ...(unit && { unit }),
        value: clamp(value), min, max, step: round2(rawStep), decimals, presets, action };
}

function parseSurface(raw) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !ID_RE.test(raw.id)) return null;
    const { id, kind } = raw;
    const action = parseAction(raw.action, kind);

    if (kind === 'header-button') {
        const label = cleanText(raw.label, CAPS.label);
        if (!label) return null;
        const text = cleanText(raw.text, CAPS.text);
        const image = raw.image == null ? null : httpsUrl(raw.image);
        return { id, kind, label, ...(text && { text }), ...(image && { image }), ...(action && { action }) };
    }

    if (kind === 'tile-mode') return parseMode(raw, id, action);

    if (kind === 'tile-hint' || kind === 'tile-line') {
        if (!TILES.includes(raw.tile)) return null;
        const text = cleanText(raw.text, kind === 'tile-hint' ? CAPS.hint : CAPS.text);
        if (!text) return null;
        const title = kind === 'tile-hint' ? cleanText(raw.title, CAPS.title) : '';
        return { id, kind, tile: raw.tile, text, ...(title && { title }), ...(action && { action }) };
    }

    return null; // unknown kind: a newer plugin on an older skin just shows less
}

// -> { surfaces: [...] }. Never throws; a wrong version or shape gives no surfaces.
export function parseSkinAnswer(raw) {
    const out = { surfaces: [] };
    if (!raw || typeof raw !== 'object' || raw.version !== SKIN_VERSION || !Array.isArray(raw.surfaces)) return out;

    const seen = new Set();
    const slots = new Set(); // one header button, and one hint, line and mode per tile
    for (const item of raw.surfaces) {
        if (out.surfaces.length >= MAX_SURFACES) break;
        const surface = parseSurface(item);
        if (!surface || seen.has(surface.id)) continue;
        const slot = surface.tile ? `${surface.kind}:${surface.tile}` : surface.kind;
        if (slots.has(slot)) continue;
        slots.add(slot);
        seen.add(surface.id);
        out.surfaces.push(surface);
    }
    return out;
}

// Loaded plugins that declare an http endpoint named `skin`; the only ones asked.
export function skinPlugins(plugins) {
    if (!Array.isArray(plugins)) return [];
    return plugins.filter(p => p?.loaded && typeof p.id === 'string'
        && Array.isArray(p.api) && p.api.some(e => e?.type === 'http' && e?.id === 'skin'));
}
