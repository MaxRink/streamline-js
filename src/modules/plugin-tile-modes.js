// plugin-tile-modes.js -- what a left-column tile does while a plugin tile-mode is
// selected in its label toggle (see docs/plugin-surfaces.md, "Tile modes").
//
// The tile's own value and preset row are left alone and hidden; the mode draws
// its own in the same place. So the tile's polling and repaint keep working on
// the hidden elements, and switching back to the built-in option just shows them.
// -/+ are caught before the tile's own handlers. Every change goes to the plugin
// through callMode(); nothing is written to the profile or workflow from here.

import { callMode, isModeCallBusy } from './plugin-surfaces-ui.js';
import { clampModeValue, stepModeValue, formatModeValue } from './plugin-modes.js';

const TILE_DOM = {
    temperature: { minus: 'temp-minus', plus: 'temp-plus', value: 'temp-value', presets: ['temp-presets'], title: 'BREW' },
    dose: { minus: 'dose-in-minus', plus: 'dose-in-plus', value: 'dose-in-value', presets: [], title: 'DOSE' },
    drink: { minus: 'drink-out-minus', plus: 'drink-out-plus', value: 'drink-out-value', presets: ['drink-out-presets'], title: 'DRINK', ownBox: true },
    grind: { minus: 'grind-minus', plus: 'grind-plus', value: 'grind-value', presets: [], title: 'GRIND' },
    flush: { minus: 'flush-minus', plus: 'flush-plus', value: 'flush-value', presets: ['flush-presets'], title: 'FLUSH' },
    // Steam keeps one preset row per built-in mode and shows one at a time, and
    // its value box holds the duration and the flow.
    steam: { minus: 'steam-minus', plus: 'steam-plus', value: 'steam-duration-value',
        presets: ['steam-presets', 'steam-flow-presets', 'steam-milk-presets', 'steam-auto-presets'], title: 'STEAM', ownBox: true },
};

const active = {}; // tile -> { plugin, surface, value, valueEl, presetButtons, overlay: [elements], restore: [fns] }
const wired = new Set();
let started = false;

function clearTile(tile) {
    const state = active[tile];
    if (!state) return;
    state.overlay.forEach(el => el.remove());
    state.restore.forEach(fn => fn());
    delete active[tile];
}

function apply(tile, number, { immediate }) {
    const state = active[tile];
    if (!state || !Number.isFinite(number)) return;
    state.value = clampModeValue(state.surface, number);
    paint(tile);
    callMode(state.plugin, state.surface, state.value, { immediate });
}

async function openNumpad(tile) {
    const state = active[tile];
    if (!state) return;
    const { plugin, surface } = state;
    const module = await import('./numpad-modal.js');
    module.initNumpadModal();
    const input = { value: String(state.value), setAttribute() {}, getAttribute() { return null; }, dispatchEvent() {} };
    module.openModal(input, {
        // Per plugin and mode, so two plugins on one tile keep their own previous-value pills.
        fieldType: `plugin-mode-${String(plugin.id)}:${surface.id}`.replace(/[^A-Za-z0-9_.:-]/g, '_'),
        config: {
            title: `${TILE_DOM[tile].title} ${surface.label}`,
            unit: surface.unit || '',
            defaultValue: String(state.value),
            min: surface.min,
            max: surface.max,
            // The "." key becomes +/- when only whole numbers are asked for and negatives are possible.
            signed: surface.min < 0 && surface.decimals === 0,
        },
        onConfirm: raw => apply(tile, parseFloat(raw), { immediate: true }),
    });
}

function paint(tile) {
    const state = active[tile];
    if (!state) return;
    const { surface } = state;
    const text = formatModeValue(surface, state.value);
    state.valueEl.textContent = text;
    state.valueEl.setAttribute('aria-label', `${surface.label} ${text}`);
    for (const button of state.presetButtons) {
        button.classList.toggle('preset-active', Number(button.dataset.modeValue) === state.value);
    }
}

function draw(tile, plugin, surface) {
    const dom = TILE_DOM[tile];
    const valueEl = dom && document.getElementById(dom.value);
    if (!valueEl || !document.getElementById(dom.minus)) return;

    // Redrawn for the same mode while a call is still going out: the user's value is
    // newer than the plugin's answer, so keep it instead of snapping back.
    const before = active[tile];
    const keep = before && before.plugin.id === plugin.id && before.surface.id === surface.id
        && isModeCallBusy(plugin, surface);
    clearTile(tile);
    const state = { plugin, surface, value: clampModeValue(surface, keep ? before.value : surface.value),
        overlay: [], restore: [], presetButtons: [], valueEl: null };
    active[tile] = state;
    const hideEl = el => {
        const before = el.style.visibility;
        el.style.visibility = 'hidden';
        state.restore.push(() => { el.style.visibility = before; });
    };

    // Value: in the tile's own box, with its own classes. The drink tile's box
    // holds the value and the ratio, so that whole box is hidden.
    const hidden = dom.ownBox ? valueEl.parentElement : valueEl;
    const mine = document.createElement('span');
    mine.className = dom.ownBox
        ? 'absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[72px] text-center text-[var(--text-primary)] text-[25.5px] font-bold'
        : valueEl.className.replace(/\bblock\b/, '').trim();
    mine.style.cursor = 'pointer';
    mine.dataset.pluginSurface = `mode-value:${tile}`;
    mine.dataset.agentId = `plugin-tile:${tile}:tile-mode-value`;
    mine.setAttribute('role', 'button');
    mine.tabIndex = 0; // aria-label is set by paint() with the current value
    mine.addEventListener('click', () => openNumpad(tile));
    mine.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        openNumpad(tile);
    });
    hideEl(hidden);
    hidden.parentElement.appendChild(mine);
    state.overlay.push(mine);
    state.valueEl = mine;

    // Presets: the plugin's own, or none. The tile's rows are taken out of the
    // layout and ours, the same size, takes the place of the first, so nothing
    // moves. Tiles without a preset row ignore the mode's presets.
    const rows = dom.presets.map(id => document.getElementById(id)).filter(Boolean);
    if (rows.length) {
        const [first] = rows;
        const template = first.firstElementChild;
        const mineRow = document.createElement('div');
        mineRow.dataset.pluginSurface = `mode-presets:${tile}`;
        mineRow.className = first.className.replace(/\bhidden\b/, '').trim();
        for (const preset of surface.presets) {
            const button = document.createElement('button');
            button.type = 'button';
            if (template) button.className = template.className.replace(/\bpreset-active\b/, '').trim();
            button.textContent = formatModeValue(surface, preset);
            button.dataset.modeValue = String(preset);
            button.addEventListener('click', () => apply(tile, preset, { immediate: true }));
            mineRow.appendChild(button);
            state.presetButtons.push(button);
        }
        for (const row of rows) {
            const before = row.style.display;
            row.style.display = 'none';
            state.restore.push(() => { row.style.display = before; });
        }
        first.parentElement.insertBefore(mineRow, first);
        state.overlay.push(mineRow);
    }
    paint(tile);
    wire(tile);
}

// Caught on the wrapper in the capture phase, before the tile's own -/+ handlers.
function wire(tile) {
    if (wired.has(tile)) return;
    const dom = TILE_DOM[tile];
    const parent = document.getElementById(dom.minus)?.parentElement;
    if (!parent) return;
    wired.add(tile);
    parent.addEventListener('click', event => {
        const state = active[tile];
        const button = event.target.closest?.('button');
        if (!state || !button || (button.id !== dom.minus && button.id !== dom.plus)) return;
        event.stopPropagation();
        event.preventDefault();
        apply(tile, stepModeValue(state.surface, state.value, button.id === dom.plus ? 1 : -1), { immediate: false });
    }, true);
}

export function initTileModes() {
    if (started) return;
    started = true;
    document.addEventListener('streamline:tilemodechange', event => {
        const { tile, plugin, surface } = event.detail || {};
        if (!TILE_DOM[tile]) return;
        if (plugin && surface) draw(tile, plugin, surface);
        else clearTile(tile);
    });
}
