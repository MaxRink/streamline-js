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

// Same look as the DYE and Settings buttons; width is content-driven so a
// plugin label is not cut to the 135px a system label gets.
const BUTTON_CLASS = 'settings-button flex justify-center items-center min-h-0 h-[53.7px] whitespace-nowrap border-[1.5px] border-solid border-[var(--mimoja-blue-v2)] text-[var(--mimoja-blue-v2)] rounded-[22.5px] text-[21px] font-semibold';

let started = false;
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
        return parseSkinAnswer(answer).surfaces.filter(s => s.kind === 'header-button');
    } catch (error) {
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

function render(entries) {
    const container = document.getElementById('header-right-controls');
    if (!container) return;
    container.querySelectorAll('[data-plugin-surface]').forEach(el => el.remove());
    const anchor = container.firstChild;
    for (const { plugin, surface } of entries) {
        container.insertBefore(buildButton(plugin, surface), anchor);
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
}
