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
export const SET_FIELDS = ['targetDoseWeight', 'targetYield', 'grinderSetting', 'brewTemperature'];
export const PRESENTATIONS = ['page', 'overlay'];

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const CAPS = { label: 24, text: 40, hint: 24, title: 80, image: 2048, value: 20 };

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

// Range clamping happens where the value is applied (the tile's own setter);
// this only guarantees shape: a known field and a finite number or short string.
function parseSet(action) {
    if (!SET_FIELDS.includes(action.field)) return null;
    let value = action.value;
    if (typeof value === 'string') {
        value = cleanText(value, CAPS.value);
        if (!value) return null;
    } else if (typeof value !== 'number' || !Number.isFinite(value)) {
        return null;
    }
    return { type: 'set', field: action.field, value };
}

// An invalid action drops the action only; the surface still shows, inert.
function parseAction(raw, kind) {
    if (!raw || typeof raw !== 'object') return null;
    if (raw.type === 'open') return parseOpen(raw);
    if (raw.type === 'set' && kind !== 'header-button') return parseSet(raw);
    return null;
}

function parseSurface(raw) {
    if (!raw || typeof raw !== 'object' || !ID_RE.test(raw.id)) return null;
    const { id, kind } = raw;
    const action = parseAction(raw.action, kind);

    if (kind === 'header-button') {
        const label = cleanText(raw.label, CAPS.label);
        if (!label) return null;
        const text = cleanText(raw.text, CAPS.text);
        const image = raw.image == null ? null : httpsUrl(raw.image);
        return { id, kind, label, ...(text && { text }), ...(image && { image }), ...(action && { action }) };
    }

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
    const slots = new Set(); // one header button, and one hint and one line per tile
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
