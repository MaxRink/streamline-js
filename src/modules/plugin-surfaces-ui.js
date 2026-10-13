// plugin-surfaces-ui.js -- renders the surfaces plugins declare through their
// `skin` endpoint (see docs/plugin-surfaces.md). The answer is parsed and
// validated by plugin-surfaces.js; this module only reads it, draws it with
// textContent, and navigates. No plugin code runs here.
//
// A failed or slow read hides that plugin's surfaces and never blocks the
// dashboard. With no plugin answering `skin` nothing is drawn.

import { getPlugins, callPluginEndpoint, connectPluginPush, closePluginPush, API_BASE_URL } from './api.js';
import { logger } from './logger.js';
import { parseSkinAnswer, skinPlugins, callableEndpoint, liveEndpoint } from './plugin-surfaces.js';
import { planTileModes, createCallQueue } from './plugin-modes.js';
import { getTempUnit } from './units.js';
import { pluginUiUrl } from '../settings/plugin-view.js';
import { applyPluginSet, isAutoSteamMode } from './ui.js';

const READ_TIMEOUT_MS = 2000;
const REFRESH_MS = 60000;
const CALL_TIMEOUT_MS = 5000; // a hung plugin must not hold a tile's call lane
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
    flush: { section: 'flush-section', label: 'flush-label', control: 'flush-minus' },
    // Only a tile-mode goes on steam (the parser takes no hint or line for it). Its
    // label block already holds the Time | Flow toggle, so the mode toggle goes in
    // the free line under that, and `label` is the toggle itself.
    steam: { section: 'steam-section', label: 'steam-mode-toggle', control: 'steam-minus' },
};
const MUTED = 'var(--low-contrast-white)';

let started = false;
let touchedSections = [];
let running = false;
let refreshAgain = false;
let drawnModes = {}; // tile -> [{ key, plugin, surface }] as last drawn
const selectedMode = {}; // tile -> `${plugin.id}:${surface.id}`; absent = the built-in mode
let lastRun = 0;
let lastKey = '';
let lastEntries = null; // the answer as last drawn, to re-evaluate without a read

function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function readSurfaces(plugin) {
    try {
        const answer = await withTimeout(callPluginEndpoint(plugin.id, 'skin', null, 'GET'), READ_TIMEOUT_MS);
        return parseSkinAnswer(answer);
    } catch (error) {
        // callPluginEndpoint logs an HTTP failure at error level; a timeout is
        // only logged here, at debug. Either way the plugin is just hidden, so
        // one broken plugin cannot affect the others.
        logger.debug(`Plugin surfaces: ${plugin.id} skin not read:`, error?.message);
        return { surfaces: [], live: null };
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

    bindAction(button, plugin, surface.action, surface);
    return button;
}

// The plugin's `ui` page in a dialog over the dashboard. The page must send
// `{type:'streamline:ready'}` once it has loaded (a CSP `frame-ancestors` block
// gives no event the skin could catch) and `{type:'streamline:close'}` to close.
// No ready message in time: drop the dialog and go to the page, as `page` does.
const OVERLAY_READY_MS = 3000;
let overlayOpen = false;

function openOverlay(plugin, action, pageUrl) {
    if (overlayOpen) return;
    const theme = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    const src = pluginUiUrl(plugin, API_BASE_URL, null, { view: action.view, embedTheme: theme });
    if (!src) return;
    overlayOpen = true;

    const dialog = document.createElement('dialog');
    dialog.dataset.agentId = `plugin-overlay:${plugin.id}`;
    dialog.style.cssText = 'width:min(1100px,94vw);height:min(760px,90vh);max-width:none;max-height:none;padding:0;border:0;border-radius:16px;overflow:hidden;background:var(--bg,#fff);';
    const frame = document.createElement('iframe');
    frame.src = src;
    frame.title = plugin.name || plugin.id;
    frame.style.cssText = 'display:block;width:100%;height:100%;border:0;';
    dialog.appendChild(frame);

    let timer = null;
    const finish = () => {
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
        dialog.removeEventListener('close', finish);
        if (dialog.open) dialog.close();
        dialog.remove();
        overlayOpen = false;
        refreshPluginSurfaces();
    };
    const onMessage = event => {
        if (event.source !== frame.contentWindow) return;
        const type = event.data?.type;
        if (type === 'streamline:ready') clearTimeout(timer);
        else if (type === 'streamline:close') finish();
    };
    window.addEventListener('message', onMessage);
    dialog.addEventListener('close', finish);
    document.body.appendChild(dialog);
    dialog.showModal();
    timer = setTimeout(() => {
        logger.warn('Plugin overlay did not report ready, opening as a page:', plugin.id);
        finish();
        window.location.assign(pageUrl);
    }, OVERLAY_READY_MS);
}

function bindAction(el, plugin, action, surface) {
    if (action?.type === 'call') {
        // A fixed number to the plugin's own endpoint; `skin` is read again after,
        // so the plugin's answer decides what the pill says next.
        el.addEventListener('click', () => {
            callMode(plugin, surface, action.value, { immediate: true }).then(sent => {
                if (!sent) logger.warn('Plugin call not delivered:', surface.id);
            });
        });
    } else if (action?.type === 'open') {
        const url = pluginUiUrl(plugin, API_BASE_URL, window.location.href, { view: action.view, returnPage: null });
        if (url && action.presentation === 'overlay') {
            el.addEventListener('click', () => openOverlay(plugin, action, url));
        } else if (url) {
            el.addEventListener('click', () => window.location.assign(url));
        }
    } else if (action?.type === 'set') {
        el.addEventListener('click', () => {
            if (!applyPluginSet(action.field, action.value)) logger.warn('Plugin set not applied:', action.field);
        });
    }
}

// The visible pill or line. With an action it sits inside a larger transparent
// button, because the 17px gap it lives in is too small to tap reliably.
function buildTileSurface(plugin, surface) {
    const el = document.createElement('span');
    el.textContent = surface.text;
    el.style.cssText = 'display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    const title = surface.title || surface.text;
    // Switched on: the skin's blue and bold, so a lock or a chosen option reads at a glance.
    if (surface.active) el.dataset.active = '1';

    const root = surface.action ? document.createElement('button') : el;
    if (surface.action) {
        root.appendChild(el);
        root.style.cssText = 'display:flex;align-items:flex-end;justify-content:center;background:none;border:0;padding:0;cursor:pointer;';
        bindAction(root, plugin, surface.action, surface);
        if (surface.action.type === 'call') root.setAttribute('aria-pressed', String(surface.active === true));
    } else {
        root.style.pointerEvents = 'none';
    }
    root.dataset.pluginSurface = surface.id;
    root.dataset.agentId = `plugin-tile:${surface.tile}:${surface.kind}`;
    root.title = title;
    return { root, el };
}

function placeTileSurface(plugin, surface) {
    const tile = TILES[surface.tile];
    const { root, el } = buildTileSurface(plugin, surface);
    const hit = surface.action ? 24 : 17; // the visible pill/line is 17px
    root.style.position = 'absolute';
    root.style.overflow = surface.action ? 'visible' : 'hidden';

    if (surface.kind === 'tile-hint') {
        const parent = document.getElementById(tile.control)?.parentElement;
        if (!parent) return null;
        // Pill is 17px at the bottom of the gap, ending 1px short of the next
        // row. The hit area grows upward only and is 100px wide so it stays
        // between the minus and plus buttons.
        root.style.left = '50%';
        root.style.transform = 'translateX(-50%)';
        root.style.top = `${72 + 17 - hit}px`;
        root.style.width = surface.action ? '100px' : 'auto';
        root.style.maxWidth = '246px';
        root.style.height = `${hit}px`;
        root.style.zIndex = '1';
        el.style.cssText += `max-width:100%;height:17px;line-height:17px;padding:0 10px;border-radius:9px;`
            + `font-size:13px;font-weight:600;background:var(--button-grey);color:${MUTED};`;
        if (surface.active) el.style.cssText += 'color:var(--mimoja-blue-v2);font-weight:700;box-shadow:inset 0 0 0 1.5px var(--mimoja-blue-v2);';
        parent.appendChild(root);
        return root;
    }
    const section = document.getElementById(tile.section);
    const label = document.getElementById(tile.label);
    if (!section || !label) return null;
    if (!section.style.position) {
        section.style.position = 'relative';
        touchedSections.push(section);
    }
    const top = label.offsetTop + label.offsetHeight + 1;
    root.style.left = '0';
    root.style.top = `${top + 17 - hit}px`;
    root.style.width = `${label.offsetWidth}px`;
    root.style.height = `${hit}px`;
    root.style.zIndex = '1';
    if (surface.action) root.style.justifyContent = 'flex-start';
    el.style.cssText += `width:100%;font-size:14px;line-height:17px;color:${MUTED};`;
    if (surface.active) el.style.cssText += 'color:var(--mimoja-blue-v2);font-weight:700;';
    section.appendChild(root);
    return root;
}

// What the built-in option of each tile's toggle says.
function builtinLabel(tile) {
    if (tile === 'temperature') return getTempUnit() === 'F' ? '°F' : '°C';
    if (tile === 'dose' || tile === 'drink') return 'g';
    if (tile === 'flush' || tile === 'steam') return 's';
    return document.getElementById(TILES[tile].label)?.textContent.trim() || '';
}

function modeKey(plugin, surface) {
    return `${plugin.id}:${surface.id}`;
}

// The tile reacts to this (value, steppers, presets). Sent when the selection
// changes and again when the plugin's answer for the selected mode changed.
function announceMode(tile) {
    const entry = (drawnModes[tile] || []).find(m => m.key === selectedMode[tile]) || null;
    document.dispatchEvent(new CustomEvent('streamline:tilemodechange', {
        detail: { tile, plugin: entry?.plugin || null, surface: entry?.surface || null },
    }));
}

function setSelectedMode(tile, key) {
    if ((selectedMode[tile] || null) === key) return;
    if (key) selectedMode[tile] = key; else delete selectedMode[tile];
    paintToggle(tile);
    announceMode(tile);
}

function paintToggle(tile) {
    const root = document.querySelector(`[data-plugin-surface="mode:${tile}"]`);
    if (!root) return;
    root.querySelectorAll('button').forEach(b => {
        const on = (b.dataset.modeKey || '') === (selectedMode[tile] || '');
        b.setAttribute('aria-pressed', String(on));
        b.style.color = on ? 'var(--mimoja-blue-v2)' : MUTED;
        b.style.fontWeight = on ? '700' : '600';
    });
}

// The `Auto | F | T` style toggle in the label slot. The visible text is 17px
// high like a tile-line; the 24px root (and the buttons filling it) grows upward
// over the label, which is not interactive, to give a touch target. The root is
// wider than the label by the free gap before the -/+ control so three options fit;
// it ignores pointer events itself so that gap never steals a tap.
function placeModeToggle(tile, modes) {
    const { section, label: labelId } = TILES[tile];
    const label = document.getElementById(labelId);
    // Steam's toggle sits in its own block, which is what the line is placed in.
    const sectionEl = tile === 'steam' ? label?.parentElement : document.getElementById(section);
    if (!sectionEl || !label) return false;
    if (!sectionEl.style.position) {
        sectionEl.style.position = 'relative';
        touchedSections.push(sectionEl);
    }
    // Over the label there is room to grow upward; over steam's toggle there is not.
    const hit = tile === 'steam' ? 17 : 24;
    const extra = tile === 'steam' ? 14 : 30;
    const top = label.offsetTop + label.offsetHeight + 1;
    const root = document.createElement('div');
    root.dataset.pluginSurface = `mode:${tile}`;
    root.dataset.agentId = `plugin-tile:${tile}:tile-mode`;
    root.setAttribute('role', 'group');
    root.style.cssText = `position:absolute;left:0;top:${top + 17 - hit}px;width:${label.offsetWidth + extra}px;height:${hit}px;`
        + 'z-index:1;display:flex;align-items:flex-end;gap:6px;white-space:nowrap;overflow:hidden;pointer-events:none;'
        + `font-size:14px;line-height:17px;color:${MUTED};`;

    const options = [{ key: '', label: builtinLabel(tile), title: '' },
        ...modes.map(m => ({ key: m.key, label: m.surface.label, title: m.surface.label }))];
    options.forEach((opt, i) => {
        if (i > 0) {
            const bar = document.createElement('span');
            bar.textContent = '|';
            bar.style.pointerEvents = 'none';
            root.appendChild(bar);
        }
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = opt.label;
        button.dataset.modeKey = opt.key;
        // Fills the root's height; the text sits at the bottom like a tile-line.
        button.style.cssText = `background:none;border:0;padding:${hit - 17}px 0 0;box-sizing:border-box;cursor:pointer;font:inherit;`
            + 'height:100%;min-width:32px;line-height:17px;text-align:center;overflow:hidden;text-overflow:ellipsis;pointer-events:auto;';
        if (opt.title) button.title = opt.title;
        button.addEventListener('click', () => setSelectedMode(tile, opt.key || null));
        root.appendChild(button);
    });
    sectionEl.appendChild(root);
    if (tile === 'steam' && !label.dataset.pluginModeWired) {
        // Choosing a built-in steam mode ends a plugin one.
        label.dataset.pluginModeWired = '1';
        label.addEventListener('click', () => setSelectedMode('steam', null));
        // The built-in toggle also switches on Enter and Space.
        label.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') setSelectedMode('steam', null);
        });
    }
    return true;
}

// Sends `{ [field]: number }` to the mode's own http endpoint; the answer is
// ignored and `skin` is read again, so what the plugin says is what is shown.
// Steppers pass `immediate: false` to be debounced; presets and the numpad do not.
const callQueue = createCallQueue({
    // A timeout rejects, which the queue counts as a failed send.
    send: (key, { plugin, endpoint, body }) => withTimeout(
        callPluginEndpoint(encodeURIComponent(plugin.id), endpoint, body, 'POST'), CALL_TIMEOUT_MS),
});

// A mode shares one lane per tile (newest value wins). A fixed-value hint or line
// is its own lane, so tapping it never supersedes a mode's pending value.
const callKey = (plugin, surface) => (surface.kind === 'tile-hint' || surface.kind === 'tile-line'
    ? `${plugin.id}:${surface.id}`
    : `${plugin.id}:${surface.tile}`);

// True while a call for this mode is being sent or the user is still stepping, so a
// redraw must keep the value the user is moving rather than the plugin's older one.
export function isModeCallBusy(plugin, surface) {
    return callQueue.busy(callKey(plugin, surface));
}

export function callMode(plugin, surface, number, { immediate = true } = {}) {
    const action = surface?.action;
    if (action?.type !== 'call' || !callableEndpoint(plugin, action.endpoint) || !Number.isFinite(number)) {
        return Promise.resolve(false);
    }
    const payload = { plugin, endpoint: action.endpoint, body: { [action.field]: number } };
    return callQueue.request(callKey(plugin, surface), payload, { immediate }).then(sent => {
        // null: a newer call replaced or overtook this one, which will refresh.
        // Otherwise read skin again and redraw even if the answer is unchanged, so
        // a number the plugin refused snaps back.
        if (sent !== null) { lastKey = ''; refreshPluginSurfaces(); }
        return sent === true;
    }).catch(() => false);
}

// -> true when everything was drawn. Tile placement measures the label
// (offsetTop/Height/Width), which is 0 while the main page is display:none, so
// tiles are skipped then and the caller must not remember the answer as drawn.
function render(rawEntries) {
    // A hint or line whose call endpoint the plugin does not declare is drawn
    // inert, like a surface with no action, so it does not look tappable.
    const entries = rawEntries.map(e => (e.surface.action?.type === 'call' && e.surface.kind !== 'tile-mode'
        && !callableEndpoint(e.plugin, e.surface.action.endpoint)
        ? { ...e, surface: { ...e.surface, action: null } } : e));
    lastEntries = entries;
    const mainHidden = document.getElementById('main-page')?.style.display === 'none';
    document.querySelectorAll('[data-plugin-surface]').forEach(el => {
        // The tile's value and presets overlays belong to the tile-modes module,
        // which clears them when the mode is left.
        const owner = el.dataset.pluginSurface;
        if (owner.startsWith('mode-value:') || owner.startsWith('mode-presets:')) return;
        el.remove();
    });
    touchedSections.forEach(el => { el.style.position = ''; });
    touchedSections = [];

    const container = document.getElementById('header-right-controls');
    const anchor = container?.firstChild;
    const usedSlots = new Set(); // two plugins asking for the same tile slot: first wins
    let headerButtons = 0;

    // A mode takes the label slot, so a tile-line on that tile is not drawn.
    // A mode whose endpoint cannot be called is never drawn, and neither is a steam
    // mode while the built-in Auto mode owns the steam -/+.
    const steamAuto = isAutoSteamMode();
    const plan = planTileModes(entries.filter(({ plugin, surface }) => surface.kind !== 'tile-mode'
        || (callableEndpoint(plugin, surface.action?.endpoint) && !(surface.tile === 'steam' && steamAuto))));
    const modeTiles = new Set(Object.keys(plan).filter(tile => TILES[tile]));
    drawnModes = {};

    for (const { plugin, surface } of entries) {
        if (surface.kind === 'header-button') {
            // One plugin button in total, the first plugin in Decaid's list whose
            // read succeeded wins: the header has no room for more when the DYE2
            // button is off.
            if (container && headerButtons < MAX_PLUGIN_HEADER_BUTTONS) {
                container.insertBefore(buildButton(plugin, surface), anchor);
                headerButtons += 1;
            }
            continue;
        }
        if (mainHidden) continue;
        if (surface.kind === 'tile-mode') continue; // drawn per tile below
        if (surface.kind === 'tile-line' && modeTiles.has(surface.tile)) continue;
        const slot = `${surface.kind}:${surface.tile}`;
        if (usedSlots.has(slot) || !TILES[surface.tile]) continue;
        if (placeTileSurface(plugin, surface)) usedSlots.add(slot);
    }

    if (!mainHidden) {
        for (const tile of modeTiles) {
            const modes = plan[tile].map(({ plugin, surface }) => ({ key: modeKey(plugin, surface), plugin, surface }));
            if (placeModeToggle(tile, modes)) drawnModes[tile] = modes;
        }
        // A selected mode that is gone (plugin off, answer changed) falls back to the built-in one.
        for (const tile of Object.keys(selectedMode)) {
            if (!(drawnModes[tile] || []).some(m => m.key === selectedMode[tile])) setSelectedMode(tile, null);
        }
        Object.keys(drawnModes).forEach(paintToggle);
        // The answer may have changed the selected mode's value or presets.
        Object.keys(selectedMode).forEach(announceMode);
    }
    return !mainHidden;
}

export async function refreshPluginSurfaces() {
    if (running) { refreshAgain = true; return; } // e.g. a mode call finished mid-read
    running = true;
    lastRun = Date.now();
    try {
        const plugins = skinPlugins(await getPlugins());
        const entries = [];
        const live = new Map(); // plugin id -> websocket endpoint it pushes "changed" on
        for (const plugin of plugins) {
            const answer = await readSurfaces(plugin);
            for (const surface of answer.surfaces) entries.push({ plugin, surface });
            const endpoint = liveEndpoint(plugin, answer.live);
            if (endpoint) live.set(plugin.id, endpoint);
        }
        syncLive(live);
        // Skip the DOM work when nothing changed: a rebuild resizes the header
        // controls, which re-runs the strip fit.
        const key = JSON.stringify(entries.map(e => [e.plugin.id, e.surface]));
        if (key === lastKey) return;
        // Only remember the answer once it was fully drawn; a render skipped
        // while the main page is hidden is retried by the next refresh.
        lastKey = render(entries) ? key : '';
    } catch (error) {
        logger.warn('Plugin surfaces refresh failed:', error);
    } finally {
        running = false;
        if (refreshAgain) { refreshAgain = false; refreshPluginSurfaces(); }
    }
}

// Sockets a plugin asked for with `live`: one per plugin, only while the page is
// visible. A message re-reads `skin` and asks the tiles to re-read the workflow
// (the plugin may have changed it). A burst is one read: the wait starts at the
// first message and is not pushed back by later ones, so a fast stream still
// refreshes every PUSH_DEBOUNCE_MS.
const PUSH_DEBOUNCE_MS = 300;
const liveSockets = new Map(); // plugin id -> endpoint
let pushTimer = null;

function onPush() {
    if (pushTimer) return;
    pushTimer = setTimeout(() => {
        pushTimer = null;
        refreshPluginSurfaces();
        document.dispatchEvent(new Event('streamline:workflow-refresh'));
    }, PUSH_DEBOUNCE_MS);
}

function closeLive() {
    for (const id of liveSockets.keys()) closePluginPush(id);
    liveSockets.clear();
}

function syncLive(wanted) {
    if (document.hidden) { closeLive(); return; }
    for (const id of [...liveSockets.keys()]) {
        if (wanted.get(id) !== liveSockets.get(id)) { closePluginPush(id); liveSockets.delete(id); }
    }
    for (const [id, endpoint] of wanted) {
        if (liveSockets.get(id) === endpoint) continue;
        connectPluginPush(id, endpoint, onPush);
        liveSockets.set(id, endpoint);
    }
}

function refreshIfDue() {
    if (Date.now() - lastRun >= MIN_GAP_MS) refreshPluginSurfaces();
}

// Idempotent: the main page can be mounted more than once per session.
export function initPluginSurfaces() {
    if (started) return;
    started = true;
    import('./plugin-tile-modes.js').then(m => m.initTileModes());
    refreshPluginSurfaces();
    setInterval(refreshPluginSurfaces, REFRESH_MS);
    window.addEventListener('focus', refreshIfDue);
    document.addEventListener('visibilitychange', () => {
        // Visible again: read now (also reopens the live sockets closed when hidden).
        if (document.visibilityState === 'visible') refreshPluginSurfaces();
        else closeLive();
    });
    // Entering or leaving the built-in Auto steam mode: draw again from the last
    // answer, which hides or restores the steam toggle.
    document.addEventListener('streamline:steamautochange', () => {
        if (lastEntries && !render(lastEntries)) lastKey = '';
    });
    // Returning from a sub-page: a surface rendered while the page was hidden
    // must be placed again, so forget the last drawn answer.
    document.addEventListener('streamline:mainpagevisible', () => {
        // Not refreshIfDue: a hidden refresh just before returning would put this
        // one inside the 2 s gap and leave the tiles undrawn until the next minute.
        // `running` already stops overlapping reads.
        lastKey = '';
        refreshPluginSurfaces();
    });
}
