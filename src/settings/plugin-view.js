// plugin-view.js — pure metadata -> view-model mapping shared by every generic
// plugin settings card (see the Plugins category in settings.js). Everything
// here operates on the array GET /plugins already returns (api.js getPlugins())
// as plain data: no network, no DOM, no i18n import. That keeps it importable
// directly by node:test (AGENTS.md: "Node tests import DOM-free modules only")
// and lets any page that draws a plugin's settings -- the Plugins list, DYE2's
// master-switch card, a future plugin with no skin code at all -- read the same
// install/enable/update state instead of re-deriving it per page, which is how
// the old dye2/printtheshot pages drifted from each other despite doing the
// same thing.
//
// Manifest text (name, description, setting labels) is untrusted: a plugin
// installs from an arbitrary GitHub repo, so its author controls those strings.
// escapeHtml here is the one place that text is made safe for innerHTML; every
// renderer must route plugin-supplied text through it (or through textContent).

export function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function findPlugin(plugins, pluginId) {
    return Array.isArray(plugins) ? (plugins.find(p => p?.id === pluginId) || null) : null;
}

// Presentation only: settings managed by a plugin's own UI must stay in the
// manifest for Decaid to retain and validate their stored values.
export function isPluginSettingVisible(schema) {
    return schema?.hidden !== true;
}

// Pass the actual skin address, including its assigned port, explicitly.
// Cross-origin referrers can lose the path/query or be absent in a WebView.
// `returnPage` is the skin page the plugin returns to (settings by default, or
// null for the dashboard); `view` selects a screen inside the plugin's own UI.
// `embedTheme` ('light' | 'dark') is for an overlay frame: the page gets
// `embed=1&theme=` and no `returnTo`, since closing is a message, not a navigation.
export function pluginUiUrl(plugin, apiBaseUrl, currentUrl, { view = '', returnPage = 'settings', embedTheme = '' } = {}) {
    const endpoints = Array.isArray(plugin?.api) ? plugin.api : [];
    if (!endpoints.some(e => e?.type === 'http' && e?.id === 'ui')) return null;
    const uiUrl = `${apiBaseUrl}/plugins/${encodeURIComponent(plugin.id)}/ui`;
    const params = [];
    if (embedTheme) params.push('embed=1', `theme=${embedTheme === 'light' ? 'light' : 'dark'}`);
    if (currentUrl && !embedTheme) {
        try {
            const returnTo = new URL(currentUrl);
            if (['http:', 'https:'].includes(returnTo.protocol) && !returnTo.username && !returnTo.password) {
                if (returnPage) returnTo.searchParams.set('page', returnPage);
                else returnTo.searchParams.delete('page');
                params.push(`returnTo=${encodeURIComponent(returnTo.href)}`);
            }
        } catch { /* no returnTo: the plugin falls back to its own default */ }
    }
    if (view) params.push(`view=${encodeURIComponent(view)}`);
    return params.length ? `${uiUrl}?${params.join('&')}` : uiUrl;
}

// Only these two kinds are checkable: updateAllPlugins skips everything else
// (plugin_source_service.dart, `!source.kind.isManaged` -> continue), so a
// local ZIP or folder install is a snapshot that can never report an update.
const MANAGED_SOURCE_KINDS = ['github_release', 'github_branch'];

export function isManagedPluginSource(source) {
    return MANAGED_SOURCE_KINDS.includes(source?.kind);
}

// The install/enable/update state machine a generic settings card renders
// differently for:
//  - 'unreachable'     GET /plugins failed outright; nothing else is known
//  - 'not-installed'   bridge reachable, plugin absent from the list
//  - 'disabled'        installed but not currently loaded
//  - 'update-pending'  loaded, and Decaid is holding an update back for
//                       permissions the installed copy does not have
//  - 'bundled'         loaded, no source at all: it came with Decaid and moves
//                       when Decaid does (Decaid seeds real sources for the
//                       three bundled plugins that do ship separately --
//                       dye2, shot-upload, dcamp -- so those land elsewhere)
//  - 'untracked'       loaded, but installed from a local ZIP/folder: a
//                       snapshot nothing can check
//  - 'check-failed'    loaded and checkable, but the last check errored
//  - 'never-checked'   loaded and checkable, but no check has ever run
//  - 'enabled'         loaded, checkable, and a check has actually confirmed it
//
// The last four used to be one 'enabled' -> "Up to date". That was a claim the
// data never supported: `pendingUpdate` only holds an update Decaid refused to
// auto-install because it wants NEW PERMISSIONS, so "no pending update" means
// "nothing is being held back", not "nothing newer exists". A folder install is
// never even looked at, and a rate-limited check (GitHub allows 60/h
// unauthenticated for the whole tablet) records an error while the pill still
// read "Up to date". Say what is known instead.
//
// `plugins === null` is the getPlugins() failure sentinel (distinct from `[]`,
// which means the bridge is fine and genuinely has no plugins) -- collapsing
// the two would tell a user with a working plugin to go reinstall it.
export function pluginStatus(plugins, pluginId) {
    if (!plugins) return 'unreachable';
    const plugin = findPlugin(plugins, pluginId);
    if (!plugin) return 'not-installed';
    if (!plugin.loaded) return 'disabled';
    if (plugin.pendingUpdate) return 'update-pending';
    if (!plugin.source) return 'bundled';
    if (!isManagedPluginSource(plugin.source)) return 'untracked';
    if (plugin.source.lastError) return 'check-failed';
    if (!Number.isFinite(Date.parse(plugin.source.lastChecked || ''))) return 'never-checked';
    return 'enabled';
}

export const PLUGIN_MANAGEMENT_PROBE_KEY = '__streamline_probe__';

export function pluginManagementProbeTarget(plugins) {
    if (!Array.isArray(plugins)) return null;
    const target = plugins.find(plugin => {
        const settings = plugin?.settings;
        return typeof plugin?.id === 'string' && settings && typeof settings === 'object'
            && Object.keys(settings).length > 0 && !(PLUGIN_MANAGEMENT_PROBE_KEY in settings);
    });
    return target?.id ?? null;
}

export function pluginManagementAllowed(probeStatus) {
    return Number.isInteger(probeStatus) && probeStatus !== 401 && probeStatus !== 403;
}

export function pluginChangeBlockedByMachine(machineState) {
    return machineState === 'espresso';
}

/** Whole minutes since `iso`, or null when it is absent or unparseable. */
export function minutesSince(iso, now = Date.now()) {
    const at = Date.parse(iso || '');
    if (!Number.isFinite(at)) return null;
    return Math.max(0, Math.floor((now - at) / 60000));
}

// Decaid re-checks every managed plugin on one 12-hourly timer, so a release
// can be up to half a day old before a card would notice it. Opening the
// Extensions page asks for a fresh answer instead -- but the check costs an
// unauthenticated api.github.com request per managed plugin, against a 60/h
// budget shared with Decaid's own timer and skin updates, and re-entering a
// settings page is something a user does freely. So: only when something is
// actually checkable, and not if every checkable plugin was already checked
// inside the cooldown (or we asked this recently ourselves).
export const PLUGIN_UPDATE_COOLDOWN_MS = 15 * 60 * 1000;

export function shouldCheckPluginUpdates(plugins, { now = Date.now(), lastRunAt = null } = {}) {
    if (!Array.isArray(plugins)) return false;
    if (Number.isFinite(lastRunAt) && now - lastRunAt < PLUGIN_UPDATE_COOLDOWN_MS) return false;
    const managed = plugins.filter(plugin => isManagedPluginSource(plugin?.source));
    if (managed.length === 0) return false;
    return managed.some(plugin => {
        const checkedAt = Date.parse(plugin.source.lastChecked || '');
        return !Number.isFinite(checkedAt) || now - checkedAt >= PLUGIN_UPDATE_COOLDOWN_MS;
    });
}

// Everything a generic plugin settings card needs to decide what to draw,
// derived only from what GET /plugins already returned. Name/description are
// raw manifest content -- untrusted -- and must be escaped (or set via
// textContent) by the caller before reaching innerHTML.
export function pluginViewModel(plugins, pluginId) {
    const status = pluginStatus(plugins, pluginId);
    const plugin = findPlugin(plugins, pluginId);
    const settingsSchema = plugin?.settings && typeof plugin.settings === 'object' ? plugin.settings : {};
    return {
        id: pluginId,
        plugin,
        status,
        reachable: status !== 'unreachable',
        name: plugin?.name || null,
        description: plugin?.description || null,
        version: plugin?.version || null,
        source: plugin?.source || null,
        pending: plugin?.pendingUpdate || null,
        loaded: !!plugin?.loaded,
        settingsSchema,
        settingsKeys: Object.keys(settingsSchema).filter(key => isPluginSettingVisible(settingsSchema[key])),
    };
}

// Translation-key labels for each status pill. The caller runs these through
// getTranslation (i18n import stays out of this module -- see file header).
export function pluginStatusLabel(status) {
    switch (status) {
        case 'unreachable': return 'Could not check';
        case 'not-installed': return 'Not installed';
        case 'disabled': return 'Not loaded';
        case 'update-pending': return 'Update needs approval';
        case 'bundled': return 'Ships with Decaid';
        case 'untracked': return 'Cannot check for updates';
        case 'check-failed': return 'Update check failed';
        case 'never-checked': return 'Not checked yet';
        case 'enabled': return 'Up to date';
        default: return 'Unknown';
    }
}

export const AUTO_FLOW_CAL_PLUGIN_ID = 'auto-flow-cal.reaplugin';

// A stored boolean wins, then the manifest's own default, then the fallback.
// GET /plugins/:id/settings answers {} (HTTP 200) for a plugin that is not
// loaded, so "nothing stored" has to resolve through the manifest defaults.
function resolvePluginBoolean(plugin, settings, key, fallback) {
    if (typeof settings?.[key] === 'boolean') return settings[key];
    const manifestDefault = plugin?.settings?.[key]?.default;
    return typeof manifestDefault === 'boolean' ? manifestDefault : fallback;
}

// True when the Auto Flow Calibration plugin is actively adjusting the flow
// multiplier: loaded, Enabled, and not in DryRun. `loaded` is what keeps an
// installed-but-off plugin (whose empty settings default to Enabled) from
// counting as managing.
export function isFlowCalPluginManaging(plugins, settings) {
    const plugin = findPlugin(plugins, AUTO_FLOW_CAL_PLUGIN_ID);
    if (!plugin || plugin.loaded !== true) return false;
    const enabled = resolvePluginBoolean(plugin, settings, 'Enabled', true);
    const dryRun = resolvePluginBoolean(plugin, settings, 'DryRun', false);
    return enabled && !dryRun;
}

// Category id for a single plugin's own settings page. The Extensions nav grows
// one subcategory per installed plugin instead of stacking every plugin onto one
// endless page, so each needs a routable category of its own -- derived from the
// plugin id rather than stored anywhere, since the set of plugins is whatever
// the connected Decaid happens to have.
export const PLUGIN_CATEGORY_PREFIX = 'plugin:';

export function pluginCategoryFor(pluginId) {
    return `${PLUGIN_CATEGORY_PREFIX}${pluginId}`;
}

export function pluginIdFromCategory(category) {
    return typeof category === 'string' && category.startsWith(PLUGIN_CATEGORY_PREFIX)
        ? category.slice(PLUGIN_CATEGORY_PREFIX.length)
        : null;
}

// The Extensions subcategory rows for the plugins Decaid reports, plus any
// plugin the skin can install itself (DYE2) that is not installed yet -- those
// have no entry in GET /plugins at all, so they would otherwise be unreachable.
// Sorted by display name: GET /plugins returns load order, which shuffles as
// plugins are installed and removed, and a nav list that reorders itself between
// visits is worse than one that ignores load order.
export function pluginNavEntries(plugins, selfInstallableIds = []) {
    const installed = Array.isArray(plugins) ? plugins.filter(p => p?.id) : [];
    const installedIds = new Set(installed.map(p => p.id));
    const entries = installed.map(p => ({ pluginId: p.id, name: p.name || p.id }));
    for (const id of selfInstallableIds) {
        if (!installedIds.has(id)) entries.push({ pluginId: id, name: id });
    }
    return entries
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(entry => ({
            id: pluginCategoryFor(entry.pluginId),
            pluginId: entry.pluginId,
            name: entry.name,
            settingsCategory: pluginCategoryFor(entry.pluginId),
        }));
}

// ─── Plugin pages, setup status and grants ───────────────────────────────────

const SURFACE_ROLES = ['setup', 'settings', 'diagnostics'];

const declaresHttpEndpoint = (plugin, id) =>
    Array.isArray(plugin?.api) && plugin.api.some(e => e?.type === 'http' && e?.id === id);

const pluginPagePath = pluginId => `/api/v1/plugins/${encodeURIComponent(pluginId)}/`;

function pluginPageUrl(href, apiOrigin, pluginId) {
    if (typeof href !== 'string' || !href) return null;
    try {
        const url = new URL(href, apiOrigin);
        return url.origin === apiOrigin && !url.username && !url.password
            && url.pathname.startsWith(pluginPagePath(pluginId)) ? url : null;
    } catch {
        return null;
    }
}

const trimmed = value => (typeof value === 'string' && value.trim() ? value.trim() : null);

/**
 * A device page of this plugin, from the `surfaces` Decaid lists on a connected device
 * (`GET /grinder/info`, `GET /scale/info`): `{ role, label, href }`, href confined to this
 * plugin's pages on the API origin.
 */
export function pluginDeviceSurfaces(pluginId, deviceInfos, apiOrigin) {
    return (Array.isArray(deviceInfos) ? deviceInfos : []).flatMap(info =>
        (Array.isArray(info?.surfaces) ? info.surfaces : []).flatMap(surface => {
            const url = pluginPageUrl(surface?.href, apiOrigin, pluginId);
            const role = trimmed(surface?.role);
            return url && SURFACE_ROLES.includes(role) ? [{ role, label: trimmed(surface.label), href: url.href }] : [];
        }));
}

/**
 * The plugin's own Set up, Settings and Diagnostics pages, at most one per role, in that order.
 * Declared top-level `surfaces` win; a host that drops them still gets Set up from a `setup`
 * HTTP endpoint. A plugin-level page whose endpoint a connected device also serves opens that
 * device's page (it carries the deviceId). Endpoint `ui` is left to the existing Open button.
 */
export function pluginSurfaceLinks(plugin, apiOrigin, deviceSurfaces = []) {
    if (!plugin?.id || !plugin.loaded) return [];
    const declared = Array.isArray(plugin.surfaces)
        ? plugin.surfaces
        : declaresHttpEndpoint(plugin, 'setup') ? [{ id: 'setup', role: 'setup', endpoint: 'setup' }] : [];
    const links = new Map();
    for (const surface of declared) {
        const role = trimmed(surface?.role);
        const endpoint = trimmed(surface?.endpoint);
        if (!SURFACE_ROLES.includes(role) || links.has(role) || endpoint === 'ui') continue;
        let url = pluginPageUrl(surface.href, apiOrigin, plugin.id);
        if (!url && endpoint && declaresHttpEndpoint(plugin, endpoint)) {
            url = new URL(`${pluginPagePath(plugin.id)}${encodeURIComponent(endpoint)}`, apiOrigin);
            url.searchParams.set('ui', '1');
            url.searchParams.set('surface', trimmed(surface.id) || role);
        }
        if (!url) continue;
        const status = new URL(url.pathname, apiOrigin);
        status.searchParams.set('status', '1');
        const device = deviceSurfaces.find(d => new URL(d.href).pathname === url.pathname);
        links.set(role, { role, label: trimmed(surface.label), href: device ? device.href : url.href, statusHref: role === 'setup' ? status.href : null });
    }
    for (const device of deviceSurfaces) {
        if (!links.has(device.role)) links.set(device.role, { ...device, statusHref: null });
    }
    return SURFACE_ROLES.filter(role => links.has(role)).map(role => links.get(role));
}

/** `GET <setup>?status=1` -> `{ needsSetup, message }`, or null for a plugin that reports no setup status. */
export function parseSetupStatus(body) {
    if (!body || typeof body !== 'object' || typeof body.needsSetup !== 'boolean') return null;
    return { needsSetup: body.needsSetup, message: trimmed(body.message) };
}

/** The machine-control grant Decaid reports for a plugin (`{ granted, reason }`), or null on a host without grants. */
export function pluginMachineControl(plugin) {
    const grant = plugin?.machineControl;
    if (typeof grant === 'boolean') return { granted: grant, reason: null };
    if (grant && typeof grant === 'object' && typeof grant.granted === 'boolean') return { granted: grant.granted, reason: trimmed(grant.reason) };
    return null;
}

// ─── Generated-form hints (presentation only; Decaid passes them through) ────

/** An enum's options: `valueLabels` names a value, `valueDescriptions` explains it; the raw value is the fallback. */
export function pluginEnumOptions(schema) {
    const text = (map, value) => (map && typeof map === 'object' ? trimmed(map[value]) : null);
    return (Array.isArray(schema?.values) ? schema.values : []).map(raw => {
        const value = String(raw);
        return { value, label: text(schema.valueLabels, value) ?? value, description: text(schema.valueDescriptions, value) };
    });
}

export function isAdvancedPluginSetting(schema) {
    return schema?.advanced === true;
}

/** A string setting whose default is a JSON object or array: edited as text, validated as JSON. */
export function isJsonPluginSetting(schema) {
    if (schema?.type !== 'string' || typeof schema.default !== 'string') return false;
    try {
        const parsed = JSON.parse(schema.default);
        return parsed !== null && typeof parsed === 'object';
    } catch {
        return false;
    }
}

export function pluginSettingUsesTextarea(schema) {
    return schema?.type === 'string' && schema.secure !== true && (schema.multiline === true || isJsonPluginSetting(schema));
}

/** The value a text setting saves: trimmed, and for a JSON setting only when it parses to an object or array. */
export function parsePluginTextSetting(text, schema) {
    const value = String(text ?? '').trim();
    if (!isJsonPluginSetting(schema)) return { value };
    try {
        const parsed = JSON.parse(value);
        return parsed !== null && typeof parsed === 'object' ? { value } : { error: 'Invalid JSON' };
    } catch {
        return { error: 'Invalid JSON' };
    }
}
