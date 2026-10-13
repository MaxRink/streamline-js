// plugin-surfaces-ui.js -- renders the surfaces plugins declare through their
// `skin` endpoint (see docs/plugin-surfaces.md). The answer is parsed and
// validated by plugin-surfaces.js; this module only reads it, draws it with
// textContent, and navigates. No plugin code runs here.
//
// A failed or slow read hides that plugin's surfaces and never blocks the
// dashboard. With no plugin answering `skin` nothing is drawn.

import { getPlugins, callPluginEndpoint, API_BASE_URL } from './api.js';
import { logger } from './logger.js';
import { parseSkinAnswer, skinPlugins } from './plugin-surfaces.js';
import { pluginUiUrl } from '../settings/plugin-view.js';

const READ_TIMEOUT_MS = 2000;
const REFRESH_MS = 60000;
const MIN_GAP_MS = 2000; // focus + visibilitychange can both fire
const MAX_PLUGIN_HEADER_BUTTONS = 1; // across all plugins

// Same look as the DYE and Settings buttons; width is content-driven so a
// plugin label is not cut to the 135px a system label gets.
const BUTTON_CLASS = 'settings-button flex justify-center items-center min-h-0 h-[53.7px] whitespace-nowrap border-[1.5px] border-solid border-[var(--mimoja-blue-v2)] text-[var(--mimoja-blue-v2)] rounded-[22.5px] text-[21px] font-semibold';

// Where each tile's surfaces go. Both are placed without moving anything: the
// 72px control row has ~17px of empty space under the label and ~17px of gap
// under the buttons, so a line sits under the label and a hint under the value.
const TILES = {
    grind: { section: 'grind-section', label: 'grind-label', control: 'grind-minus' },
    dose: { section: 'dose-section', label: 'dose-label', control: 'dose-in-minus' },
    drink: { section: 'drink-section', label: 'drink-label', control: 'drink-out-minus' },
    temperature: { section: 'brew-section', label: 'brew-label', control: 'temp-minus' },
};
const MUTED = 'var(--low-contrast-white)';

let started = false;
let touchedSections = [];
let running = false;
let lastRun = 0;
let lastKey = '';

function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function readSurfaces(plugin) {
    try {
        const answer = await withTimeout(callPluginEndpoint(plugin.id, 'skin', null, 'GET'), READ_TIMEOUT_MS);
        return parseSkinAnswer(answer).surfaces;
    } catch (error) {
        // callPluginEndpoint already logs the failure at error level; here it is
        // only hidden so one broken plugin cannot affect the others.
        logger.debug(`Plugin surfaces: ${plugin.id} skin not read:`, error?.message);
        return [];
    }
}

function buildButton(plugin, surface) {
    const button = document.createElement('button');
    button.className = BUTTON_CLASS;
    button.dataset.pluginSurface = `${plugin.id}:${surface.id}`;
    button.dataset.agentId = `plugin:${plugin.id}:${surface.id}`;
    button.style.cssText = 'padding:0 22px;min-width:135px;max-width:260px;gap:10px;';
    if (surface.image) {
        const img = document.createElement('img');
        img.src = surface.image;
        img.alt = '';
        img.style.cssText = 'width:32px;height:32px;border-radius:6px;object-fit:cover;flex:none;';
        button.appendChild(img);
    }
    const label = document.createElement('span');
    label.textContent = surface.label;
    label.style.cssText = 'overflow:hidden;text-overflow:ellipsis;';
    button.appendChild(label);
    if (surface.text) button.title = surface.text;
    button.setAttribute('aria-label', surface.text ? `${surface.label}: ${surface.text}` : surface.label);

    const action = surface.action;
    if (action?.type === 'open') {
        // `presentation` is a hint; only same-frame navigation exists so far.
        const url = pluginUiUrl(plugin, API_BASE_URL, window.location.href, { view: action.view, returnPage: null });
        if (url) button.addEventListener('click', () => window.location.assign(url));
    }
    return button;
}

function buildTileSurface(surface) {
    const el = document.createElement('span');
    el.dataset.pluginSurface = surface.id;
    el.dataset.agentId = `plugin-tile:${surface.tile}:${surface.kind}`;
    el.textContent = surface.text;
    el.title = surface.title || surface.text;
    // Display only for now: actions on tile surfaces arrive with the `set` step.
    el.style.cssText = 'position:absolute;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;';
    return el;
}

function placeTileSurface(surface) {
    const tile = TILES[surface.tile];
    const el = buildTileSurface(surface);
    if (surface.kind === 'tile-hint') {
        const parent = document.getElementById(tile.control)?.parentElement;
        if (!parent) return null;
        el.style.cssText += `left:50%;transform:translateX(-50%);top:73px;max-width:246px;height:17px;line-height:17px;`
            + `padding:0 10px;border-radius:9px;font-size:13px;font-weight:600;background:var(--button-grey);color:${MUTED};`;
        parent.appendChild(el);
        return el;
    }
    const section = document.getElementById(tile.section);
    const label = document.getElementById(tile.label);
    if (!section || !label) return null;
    if (!section.style.position) {
        section.style.position = 'relative';
        touchedSections.push(section);
    }
    el.style.cssText += `left:0;top:${label.offsetTop + label.offsetHeight + 1}px;width:${label.offsetWidth}px;`
        + `font-size:14px;line-height:17px;color:${MUTED};`;
    section.appendChild(el);
    return el;
}

function render(entries) {
    document.querySelectorAll('[data-plugin-surface]').forEach(el => el.remove());
    touchedSections.forEach(el => { el.style.position = ''; });
    touchedSections = [];

    const container = document.getElementById('header-right-controls');
    const anchor = container?.firstChild;
    const usedSlots = new Set(); // two plugins asking for the same tile slot: first wins
    let headerButtons = 0;
    for (const { plugin, surface } of entries) {
        if (surface.kind === 'header-button') {
            // One plugin button in total, first loaded plugin wins: the header has
            // no room for more when the DYE2 button is off.
            if (container && headerButtons < MAX_PLUGIN_HEADER_BUTTONS) {
                container.insertBefore(buildButton(plugin, surface), anchor);
                headerButtons += 1;
            }
            continue;
        }
        const slot = `${surface.kind}:${surface.tile}`;
        if (usedSlots.has(slot) || !TILES[surface.tile]) continue;
        if (placeTileSurface(surface)) usedSlots.add(slot);
    }
}

export async function refreshPluginSurfaces() {
    if (running) return;
    running = true;
    lastRun = Date.now();
    try {
        const plugins = skinPlugins(await getPlugins());
        const entries = [];
        for (const plugin of plugins) {
            for (const surface of await readSurfaces(plugin)) entries.push({ plugin, surface });
        }
        // Skip the DOM work when nothing changed: a rebuild resizes the header
        // controls, which re-runs the strip fit.
        const key = JSON.stringify(entries.map(e => [e.plugin.id, e.surface]));
        if (key === lastKey) return;
        lastKey = key;
        render(entries);
    } catch (error) {
        logger.warn('Plugin surfaces refresh failed:', error);
    } finally {
        running = false;
    }
}

function refreshIfDue() {
    if (Date.now() - lastRun >= MIN_GAP_MS) refreshPluginSurfaces();
}

// Idempotent: the main page can be mounted more than once per session.
export function initPluginSurfaces() {
    if (started) return;
    started = true;
    refreshPluginSurfaces();
    setInterval(refreshPluginSurfaces, REFRESH_MS);
    window.addEventListener('focus', refreshIfDue);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') refreshIfDue();
    });
    // Returning from a sub-page: a surface rendered while the page was hidden
    // must be placed again, so forget the last drawn answer.
    document.addEventListener('streamline:mainpagevisible', () => {
        lastKey = '';
        refreshIfDue();
    });
}
