// plugin-modes.js -- pure helpers for plugin `tile-mode` surfaces (see
// docs/plugin-surfaces.md). DOM-free so node:test can import it.

// The built-in option plus at most two plugin options fit the 112px label column.
export const MAX_OPTIONS_PER_TILE = 3;

// Entries are { plugin, surface } in Decaid's plugin order. Returns the modes each
// tile gets: the first plugins win, the rest are dropped.
export function planTileModes(entries) {
    const byTile = {};
    for (const entry of entries) {
        if (entry.surface.kind !== 'tile-mode') continue;
        const list = byTile[entry.surface.tile] || (byTile[entry.surface.tile] = []);
        if (list.length < MAX_OPTIONS_PER_TILE - 1) list.push(entry);
    }
    return byTile;
}

const round = (n, digits) => Math.round(n * 10 ** digits) / 10 ** digits;

// Mode values are clamped into [min, max] and held at the mode's decimals.
export function clampModeValue(mode, n) {
    return round(Math.min(mode.max, Math.max(mode.min, n)), mode.decimals);
}

export function stepModeValue(mode, value, direction) {
    return clampModeValue(mode, round(value + direction * mode.step, 2));
}

// `+5%`, `0%`, `-7%`; the plus sign only when the mode can go negative.
export function formatModeValue(mode, value) {
    const n = clampModeValue(mode, value);
    const text = n.toFixed(mode.decimals);
    return `${mode.min < 0 && n > 0 ? '+' : ''}${text}${mode.unit || ''}`;
}

// Sends one payload per key at a time, newest wins. `request` resolves true when
// the payload was sent, false when `send` rejected, and null when a newer payload
// replaced it before it went out. `{ immediate }` skips the debounce.
export function createCallQueue({ send, delayMs = 300, setTimer = setTimeout, clearTimer = clearTimeout }) {
    const lanes = new Map(); // key -> { timer, pending, inFlight }

    function laneFor(key) {
        let lane = lanes.get(key);
        if (!lane) {
            lane = { timer: null, pending: null, inFlight: false };
            lanes.set(key, lane);
        }
        return lane;
    }

    function run(key) {
        const lane = lanes.get(key);
        if (!lane || lane.inFlight || !lane.pending) return;
        const job = lane.pending;
        lane.pending = null;
        lane.inFlight = true;
        Promise.resolve()
            .then(() => send(key, job.payload))
            .then(() => job.resolve(true), () => job.resolve(false))
            .then(() => {
                lane.inFlight = false;
                if (lane.pending && !lane.timer) run(key);
                else if (!lane.pending && !lane.timer) lanes.delete(key);
            });
    }

    function request(key, payload, { immediate = false } = {}) {
        const lane = laneFor(key);
        if (lane.timer) { clearTimer(lane.timer); lane.timer = null; }
        if (lane.pending) lane.pending.resolve(null);
        return new Promise(resolve => {
            lane.pending = { payload, resolve };
            if (immediate) run(key);
            else lane.timer = setTimer(() => { lane.timer = null; run(key); }, delayMs);
        });
    }

    return { request };
}
