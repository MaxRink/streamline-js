import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    escapeHtml,
    findPlugin,
    pluginStatus,
    pluginViewModel,
    pluginStatusLabel,
    pluginNavEntries,
    pluginCategoryFor,
    pluginIdFromCategory,
    isPluginSettingVisible,
    isFlowCalPluginManaging,
    AUTO_FLOW_CAL_PLUGIN_ID,
    pluginManagementAllowed,
    pluginManagementProbeTarget,
    PLUGIN_MANAGEMENT_PROBE_KEY,
    pluginChangeBlockedByMachine,
    pluginSurfaceLinks,
    pluginDeviceSurfaces,
    parseSetupStatus,
    pluginMachineControl,
    pluginEnumOptions,
    isAdvancedPluginSetting,
    isJsonPluginSetting,
    pluginSettingUsesTextarea,
    parsePluginTextSetting,
} from '../src/settings/plugin-view.js';

test('plugin management opens only when the probe gets past the auth gate', () => {
    for (const status of [200, 400, 404, 500]) assert.equal(pluginManagementAllowed(status), true, String(status));
    for (const status of [401, 403, null, undefined]) assert.equal(pluginManagementAllowed(status), false, String(status));
});

test('the probe targets a plugin whose manifest rejects the probe key before any write', () => {
    assert.equal(pluginManagementProbeTarget([
        { id: 'bare.reaplugin', settings: {} },
        { id: 'claims-key.reaplugin', settings: { [PLUGIN_MANAGEMENT_PROBE_KEY]: { type: 'boolean' } } },
        { id: 'grinder.reaplugin', settings: { MockGrinder: { type: 'boolean' } } },
    ]), 'grinder.reaplugin');
    for (const plugins of [null, undefined, [], [{ id: 'bare.reaplugin' }], [{ settings: { A: {} } }]]) {
        assert.equal(pluginManagementProbeTarget(plugins), null, JSON.stringify(plugins));
    }
});

test('plugin changes wait for espresso and nothing else', () => {
    assert.equal(pluginChangeBlockedByMachine('espresso'), true);
    for (const state of ['idle', 'steam', 'flush', 'sleeping', null, undefined]) {
        assert.equal(pluginChangeBlockedByMachine(state), false, String(state));
    }
});

// plugin-view.js is the pure metadata -> view-model layer the generic plugin
// settings card (settings.js renderPluginCard/setupPluginCard) is built on.
// It is DOM-free and import-free (no api.js, no i18n), so it can be imported
// directly here instead of lifted via regex -- see test/dye2-plugin-source.test.mjs
// and test/plugin-list.test.mjs for the lift-based pattern this module avoids.

// ── findPlugin ────────────────────────────────────────────────────────────

test('findPlugin locates a plugin by id, tolerating a missing or malformed list', () => {
    const plugins = [{ id: 'a.reaplugin' }, { id: 'b.reaplugin' }];
    assert.equal(findPlugin(plugins, 'b.reaplugin'), plugins[1]);
    assert.equal(findPlugin(plugins, 'missing.reaplugin'), null);
    assert.equal(findPlugin(null, 'a.reaplugin'), null);
    assert.equal(findPlugin(undefined, 'a.reaplugin'), null);
});

// ── pluginStatus: the install/enable/update state machine ──────────────────

test('a failed GET /plugins (null) reads as unreachable, never "not installed"', () => {
    // null is getPlugins()'s failure sentinel, distinct from an empty array --
    // collapsing the two would tell a user with a working plugin to reinstall
    // it. See docs/AI_API_NOTES.md and getPlugins() in api.js.
    assert.equal(pluginStatus(null, 'dye2.reaplugin'), 'unreachable');
});

test('a reachable bridge with no matching plugin is not-installed', () => {
    assert.equal(pluginStatus([], 'dye2.reaplugin'), 'not-installed');
    assert.equal(pluginStatus([{ id: 'other.reaplugin', loaded: true }], 'dye2.reaplugin'), 'not-installed');
});

test('installed but not loaded is disabled', () => {
    assert.equal(pluginStatus([{ id: 'dye2.reaplugin', loaded: false }], 'dye2.reaplugin'), 'disabled');
});

test('loaded with a pendingUpdate is update-pending', () => {
    const plugins = [{ id: 'dye2.reaplugin', loaded: true, pendingUpdate: { version: '0.2.0', addedPermissions: ['api'] } }];
    assert.equal(pluginStatus(plugins, 'dye2.reaplugin'), 'update-pending');
});

// "No pending update" is not "up to date": pendingUpdate only holds an update
// Decaid refused to auto-install because it asks for new permissions. A plugin
// is only current once a check has actually said so — see the update-status
// tests in plugin-list.test.mjs for the full set.
test('loaded with no pending update is only enabled once a check confirms it', () => {
    const checked = { kind: 'github_release', repo: 'decentespresso/dye2', lastChecked: new Date().toISOString() };
    assert.equal(pluginStatus([{ id: 'dye2.reaplugin', loaded: true, source: checked }], 'dye2.reaplugin'), 'enabled');
    assert.equal(pluginStatus([{ id: 'dye2.reaplugin', loaded: true }], 'dye2.reaplugin'), 'bundled',
        'no source at all ships with the app, so it cannot be called current either');
});

test('pluginStatusLabel names every state the card can render', () => {
    assert.equal(pluginStatusLabel('unreachable'), 'Could not check');
    assert.equal(pluginStatusLabel('not-installed'), 'Not installed');
    assert.equal(pluginStatusLabel('disabled'), 'Not loaded');
    assert.equal(pluginStatusLabel('update-pending'), 'Update needs approval');
    assert.equal(pluginStatusLabel('bundled'), 'Ships with Decaid');
    assert.equal(pluginStatusLabel('untracked'), 'Cannot check for updates');
    assert.equal(pluginStatusLabel('check-failed'), 'Update check failed');
    assert.equal(pluginStatusLabel('never-checked'), 'Not checked yet');
    assert.equal(pluginStatusLabel('enabled'), 'Up to date');
});

// ── pluginViewModel: metadata -> view-model mapping ─────────────────────────

test('pluginViewModel maps an installed plugin\'s fields verbatim', () => {
    const plugin = {
        id: 'print-the-shot.reaplugin',
        name: 'Print The Shot',
        description: 'Sends a finished shot to a local print server.',
        version: '1.2.0',
        loaded: true,
        source: { kind: 'github_release', repo: 'decentespresso/print-the-shot', releaseTag: 'v1.2.0',
                  lastChecked: new Date().toISOString(), lastError: null },
        pendingUpdate: null,
        settings: { AutoPrint: { type: 'boolean', default: false } },
    };
    const vm = pluginViewModel([plugin], 'print-the-shot.reaplugin');
    assert.equal(vm.status, 'enabled');
    assert.equal(vm.reachable, true);
    assert.equal(vm.name, 'Print The Shot');
    assert.equal(vm.description, plugin.description);
    assert.equal(vm.version, '1.2.0');
    assert.equal(vm.loaded, true);
    assert.deepEqual(vm.source, plugin.source);
    assert.equal(vm.pending, null);
    assert.deepEqual(vm.settingsKeys, ['AutoPrint']);
    assert.deepEqual(vm.settingsSchema, plugin.settings);
});

test('pluginViewModel degrades an unreachable bridge to nulls, not a throw', () => {
    const vm = pluginViewModel(null, 'dye2.reaplugin');
    assert.equal(vm.status, 'unreachable');
    assert.equal(vm.reachable, false);
    assert.equal(vm.plugin, null);
    assert.equal(vm.name, null);
    assert.equal(vm.description, null);
    assert.equal(vm.version, null);
    assert.equal(vm.loaded, false);
    assert.deepEqual(vm.settingsKeys, []);
    assert.deepEqual(vm.settingsSchema, {});
});

test('pluginViewModel tolerates a malformed settings schema (not an object)', () => {
    const vm = pluginViewModel([{ id: 'x.reaplugin', loaded: true, settings: 'nonsense' }], 'x.reaplugin');
    assert.deepEqual(vm.settingsSchema, {});
    assert.deepEqual(vm.settingsKeys, []);
});

test('hidden settings stay in the manifest but are excluded from editable keys', () => {
    const settings = Object.freeze({
        usualMilk: Object.freeze({ type: 'number', default: 150 }),
        flowReadings: Object.freeze({ type: 'string', default: '[]', hidden: true }),
    });
    const plugin = Object.freeze({ id: 'custom.reaplugin', loaded: true, settings });
    const vm = pluginViewModel([plugin], plugin.id);
    assert.deepEqual(vm.settingsKeys, ['usualMilk']);
    assert.equal(vm.settingsSchema, settings);
    assert.equal(vm.plugin, plugin);
    assert.equal(vm.settingsSchema.flowReadings.default, '[]');
});

test('hiding every setting leaves the installed plugin visible and enabled', () => {
    const plugin = {
        id: 'custom.reaplugin', name: 'Custom settings', version: '1.0.0', loaded: true,
        api: [{ id: 'ui', type: 'http' }],
        settings: { internal: { type: 'number', default: 0, hidden: true } },
    };
    const vm = pluginViewModel([plugin], plugin.id);
    assert.deepEqual(vm.settingsKeys, []);
    assert.equal(vm.loaded, true);
    assert.equal(vm.version, '1.0.0');
    assert.equal(vm.plugin.api, plugin.api);
    assert.equal(pluginNavEntries([plugin])[0].pluginId, plugin.id);
});

test('only boolean hidden:true opts out of the generated form', () => {
    assert.equal(isPluginSettingVisible({ hidden: true }), false);
    for (const hidden of [undefined, false, null, 'true', 'false', 1, 0]) {
        assert.equal(isPluginSettingVisible({ hidden }), true);
    }
    assert.equal(isPluginSettingVisible(undefined), true);
});

// ── escapeHtml: untrusted manifest text must never reach innerHTML raw ─────

test('escapeHtml neutralizes an attacker-controlled plugin name/description', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const escaped = escapeHtml(evil);
    assert.ok(!escaped.includes('<img'));
    assert.equal(escaped, '&lt;img src=x onerror=alert(1)&gt;');
});

test('escapeHtml also covers quotes, so a manifest string cannot break out of an attribute', () => {
    const evil = `"><script>alert(1)</script>`;
    const escaped = escapeHtml(evil);
    assert.ok(!escaped.includes('"'));
    assert.ok(!escaped.includes('<script>'));
});

test('escapeHtml is a no-op on plain text', () => {
    assert.equal(escapeHtml('Print The Shot'), 'Print The Shot');
});

test('a plugin view-model built from an attacker-supplied manifest is safe once escaped', () => {
    // pluginViewModel itself does not escape (callers route text through
    // textContent or escapeHtml at render time -- see renderPluginCard in
    // settings.js) but it must not choke on or silently drop hostile input.
    const plugin = {
        id: 'evil.reaplugin',
        name: '<img src=x onerror=alert(1)>',
        description: '<script>document.cookie</script>',
        loaded: true,
    };
    const vm = pluginViewModel([plugin], 'evil.reaplugin');
    assert.equal(vm.name, plugin.name);
    assert.ok(!escapeHtml(vm.name).includes('<img'));
    assert.ok(!escapeHtml(vm.description).includes('<script>'));
});

// ── Extensions nav rows: one per plugin, not one endless page ──────────────
//
// Each installed plugin gets its own subcategory row and its own routable
// category, derived from the plugin id -- nothing about a plugin is written
// into settings-tree.js, so installing one from the Decaid dashboard is all it
// takes for the skin to show its page.

test('a plugin category round-trips to the plugin id', () => {
    assert.equal(pluginIdFromCategory(pluginCategoryFor('dye2.reaplugin')), 'dye2.reaplugin');
});

test('a non-plugin category is not mistaken for one', () => {
    for (const category of ['plugins', 'shotupload', 'extensions', '', null, undefined]) {
        assert.equal(pluginIdFromCategory(category), null);
    }
});

test('nav rows are sorted by display name, not by the load order GET /plugins returns', () => {
    const rows = pluginNavEntries([
        { id: 'z.reaplugin', name: 'Time To Ready' },
        { id: 'a.reaplugin', name: 'dcamp' },
        { id: 'm.reaplugin', name: 'Print The Shot' },
    ]);
    assert.deepEqual(rows.map(r => r.name), ['dcamp', 'Print The Shot', 'Time To Ready']);
});

test('a plugin with no manifest name falls back to its id rather than an empty row', () => {
    const [row] = pluginNavEntries([{ id: 'nameless.reaplugin' }]);
    assert.equal(row.name, 'nameless.reaplugin');
    assert.equal(row.settingsCategory, 'plugin:nameless.reaplugin');
});

test('a self-installable plugin gets a row even though it is not installed yet', () => {
    const rows = pluginNavEntries([{ id: 'other.reaplugin', name: 'Other' }], ['dye2.reaplugin']);
    assert.deepEqual(rows.map(r => r.pluginId).sort(), ['dye2.reaplugin', 'other.reaplugin']);
});

test('a self-installable plugin that IS installed is listed once, under its manifest name', () => {
    const rows = pluginNavEntries([{ id: 'dye2.reaplugin', name: 'Streamline/DYE2' }], ['dye2.reaplugin']);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 'Streamline/DYE2');
});

test('an unreachable bridge yields no rows instead of throwing', () => {
    assert.deepEqual(pluginNavEntries(null), []);
    assert.deepEqual(pluginNavEntries(undefined), []);
    assert.deepEqual(pluginNavEntries([]), []);
});

test('a malformed entry in the list does not take the whole nav down', () => {
    const rows = pluginNavEntries([null, { name: 'no id' }, { id: 'ok.reaplugin', name: 'Ok' }]);
    assert.deepEqual(rows.map(r => r.pluginId), ['ok.reaplugin']);
});

test('isFlowCalPluginManaging resolves loaded + Enabled + !DryRun', () => {
    const manifest = { Enabled: { type: 'boolean', default: true }, DryRun: { type: 'boolean', default: false } };
    const plugin = (extra = {}) => ({ id: AUTO_FLOW_CAL_PLUGIN_ID, loaded: true, settings: manifest, ...extra });

    assert.equal(isFlowCalPluginManaging([plugin()], { Enabled: true, DryRun: false }), true);
    assert.equal(isFlowCalPluginManaging([{ id: 'other.reaplugin', loaded: true }], { Enabled: true }), false);
    assert.equal(isFlowCalPluginManaging([], {}), false);
    assert.equal(isFlowCalPluginManaging(null, {}), false);
    assert.equal(isFlowCalPluginManaging([plugin({ loaded: false })], { Enabled: true, DryRun: false }), false);
    assert.equal(isFlowCalPluginManaging([plugin()], { Enabled: false }), false);
    assert.equal(isFlowCalPluginManaging([plugin()], { Enabled: true, DryRun: true }), false);
    // {} = no stored settings -> manifest defaults
    assert.equal(isFlowCalPluginManaging([plugin()], {}), true);
    assert.equal(isFlowCalPluginManaging([plugin({ loaded: false })], {}), false);
    // manifest default Enabled=false with nothing stored
    const offByDefault = plugin({ settings: { ...manifest, Enabled: { type: 'boolean', default: false } } });
    assert.equal(isFlowCalPluginManaging([offByDefault], {}), false);
    assert.equal(isFlowCalPluginManaging([offByDefault], { Enabled: true }), true);
    // null / undefined settings behave like {}
    assert.equal(isFlowCalPluginManaging([plugin()], null), true);
    assert.equal(isFlowCalPluginManaging([plugin()], undefined), true);
    // no manifest settings at all -> Enabled true, DryRun false
    assert.equal(isFlowCalPluginManaging([{ id: AUTO_FLOW_CAL_PLUGIN_ID, loaded: true }], undefined), true);
});

// --- plugin pages (Set up / Settings / Diagnostics), setup status, grants ------------

const API = 'http://tablet:8080';
const http = (...ids) => ids.map(id => ({ id, type: 'http', data: {} }));
const e64 = {
    id: 'mahlkoenig-e64.reaplugin', loaded: true,
    api: http('setup', 'ui', 'e64-diagnostics'),
    drivers: [{ id: 'e64', type: 'grinder', surfaces: [{ id: 'diagnostics', role: 'diagnostics', endpoint: 'e64-diagnostics', label: 'E64 diagnostics' }] }],
    surfaces: [
        { id: 'setup', role: 'setup', endpoint: 'setup', label: 'Set up' },
        { id: 'diagnostics', role: 'diagnostics', endpoint: 'e64-diagnostics', label: 'E64 diagnostics' },
    ],
};

test('declared plugin pages open their endpoint on the API origin, setup with a status URL', () => {
    assert.deepEqual(pluginSurfaceLinks(e64, API), [
        { role: 'setup', label: 'Set up', href: `${API}/api/v1/plugins/mahlkoenig-e64.reaplugin/setup?ui=1&surface=setup`, statusHref: `${API}/api/v1/plugins/mahlkoenig-e64.reaplugin/setup?status=1` },
        { role: 'diagnostics', label: 'E64 diagnostics', href: `${API}/api/v1/plugins/mahlkoenig-e64.reaplugin/e64-diagnostics?ui=1&surface=diagnostics`, statusHref: null },
    ]);
});

test('a host that drops top-level surfaces still offers Set up from a setup endpoint', () => {
    const { surfaces, ...stock } = e64;
    assert.deepEqual(pluginSurfaceLinks(stock, API).map(l => [l.role, l.href]), [
        ['setup', `${API}/api/v1/plugins/mahlkoenig-e64.reaplugin/setup?ui=1&surface=setup`],
    ]);
    assert.deepEqual(pluginSurfaceLinks({ ...stock, api: http('ui') }, API), []);
});

test('a connected device\'s page replaces the plugin-level one it serves, and adds roles the plugin lacks', () => {
    const deviceHref = '/api/v1/plugins/mahlkoenig-e64.reaplugin/e64-diagnostics?ui=1&deviceId=e64%3A1&deviceName=E64';
    const devices = pluginDeviceSurfaces(e64.id, [{ surfaces: [{ id: 'diagnostics', role: 'diagnostics', href: deviceHref, label: 'E64 diagnostics' }] }], API);
    assert.deepEqual(devices, [{ role: 'diagnostics', label: 'E64 diagnostics', href: `${API}${deviceHref}` }]);
    assert.equal(pluginSurfaceLinks(e64, API, devices)[1].href, `${API}${deviceHref}`);

    const skale = { id: 'skale.reaplugin', loaded: true, api: http('device-settings'), drivers: [{ type: 'scale', surfaces: [{ role: 'settings', endpoint: 'device-settings' }] }] };
    const skaleDevices = pluginDeviceSurfaces(skale.id, [{ surfaces: [{ role: 'settings', href: '/api/v1/plugins/skale.reaplugin/device-settings?ui=1&deviceId=s' }] }], API);
    assert.deepEqual(pluginSurfaceLinks(skale, API, skaleDevices).map(l => [l.role, l.label]), [['settings', null]]);
});

test('page links stay on this plugin\'s pages on the API origin', () => {
    const evil = { id: 'a.reaplugin', loaded: true, api: http('setup'), surfaces: [
        { role: 'setup', href: 'http://evil.example/api/v1/plugins/a.reaplugin/setup' },
        { role: 'settings', href: '/api/v1/plugins/other.reaplugin/settings' },
        { role: 'diagnostics', href: 'http://user:pw@tablet:8080/api/v1/plugins/a.reaplugin/d' },
    ] };
    assert.deepEqual(pluginSurfaceLinks(evil, API), []);
    assert.deepEqual(pluginDeviceSurfaces('a.reaplugin', [{ surfaces: [
        { role: 'settings', href: '/api/v1/plugins/b.reaplugin/x' },
        { role: 'settings', href: 'javascript:alert(1)' },
        { role: 'bogus', href: '/api/v1/plugins/a.reaplugin/x' },
    ] }], API), []);
});

test('page links: one per role, setup before settings before diagnostics, ui left to Open, none while unloaded', () => {
    const plugin = { id: 'd.reaplugin', loaded: true, api: http('ui', 'setup', 'diag', 'conf'), surfaces: [
        { role: 'diagnostics', endpoint: 'diag' },
        { role: 'settings', endpoint: 'ui' },
        { role: 'settings', endpoint: 'conf' },
        { role: 'setup', endpoint: 'setup' },
        { role: 'setup', endpoint: 'diag' },
        { role: 'settings', endpoint: 'undeclared' },
    ] };
    assert.deepEqual(pluginSurfaceLinks(plugin, API).map(l => [l.role, new URL(l.href).pathname]), [
        ['setup', '/api/v1/plugins/d.reaplugin/setup'],
        ['settings', '/api/v1/plugins/d.reaplugin/conf'],
        ['diagnostics', '/api/v1/plugins/d.reaplugin/diag'],
    ]);
    assert.deepEqual(pluginSurfaceLinks({ ...plugin, loaded: false }, API), []);
    assert.deepEqual(pluginSurfaceLinks(null, API), []);
});

test('setup status is read only from a boolean needsSetup', () => {
    assert.deepEqual(parseSetupStatus({ needsSetup: true, message: ' No grinder is configured yet. ' }), { needsSetup: true, message: 'No grinder is configured yet.' });
    assert.deepEqual(parseSetupStatus({ needsSetup: false, instances: [] }), { needsSetup: false, message: null });
    for (const body of [null, 'html', {}, { needsSetup: 'true' }, []]) assert.equal(parseSetupStatus(body), null, JSON.stringify(body));
});

test('machine control: shown only where Decaid reports a grant', () => {
    assert.deepEqual(pluginMachineControl({ machineControl: false }), { granted: false, reason: null });
    assert.deepEqual(pluginMachineControl({ machineControl: true }), { granted: true, reason: null });
    assert.deepEqual(pluginMachineControl({ machineControl: { granted: true, reason: ' The square button starts shots. ' } }), { granted: true, reason: 'The square button starts shots.' });
    for (const plugin of [{}, null, { machineControl: 'true' }, { machineControl: { reason: 'x' } }]) assert.equal(pluginMachineControl(plugin), null);
});

// --- generated-form hints -------------------------------------------------------------

test('enum options carry valueLabels and valueDescriptions, the raw value as fallback', () => {
    assert.deepEqual(pluginEnumOptions({
        type: 'enum', values: ['off', 'grinder', true],
        valueLabels: { off: 'Just show the grinder', grinder: '  ' },
        valueDescriptions: { grinder: 'The grinder decides.' },
    }), [
        { value: 'off', label: 'Just show the grinder', description: null },
        { value: 'grinder', label: 'grinder', description: 'The grinder decides.' },
        { value: 'true', label: 'true', description: null },
    ]);
    assert.deepEqual(pluginEnumOptions({ type: 'enum' }), []);
});

test('advanced is a boolean hint only', () => {
    assert.equal(isAdvancedPluginSetting({ advanced: true }), true);
    for (const schema of [{ advanced: 'true' }, {}, null]) assert.equal(isAdvancedPluginSetting(schema), false);
});

test('JSON and multiline strings are edited in a text area; secrets never are', () => {
    assert.equal(isJsonPluginSetting({ type: 'string', default: '[]' }), true);
    assert.equal(isJsonPluginSetting({ type: 'string', default: '{"a":1}' }), true);
    for (const schema of [{ type: 'string', default: '1' }, { type: 'string', default: 'null' }, { type: 'string', default: 'x' }, { type: 'number', default: '[]' }]) {
        assert.equal(isJsonPluginSetting(schema), false, JSON.stringify(schema));
    }
    assert.equal(pluginSettingUsesTextarea({ type: 'string', multiline: true }), true);
    assert.equal(pluginSettingUsesTextarea({ type: 'string', default: '[]' }), true);
    assert.equal(pluginSettingUsesTextarea({ type: 'string', default: '{}', secure: true }), false);
    assert.equal(pluginSettingUsesTextarea({ type: 'string', multiline: 'yes' }), false);
});

test('a JSON setting saves only JSON objects or arrays; other text is trimmed', () => {
    const json = { type: 'string', default: '[]' };
    assert.deepEqual(parsePluginTextSetting(' [{"id":"a"}]\n', json), { value: '[{"id":"a"}]' });
    for (const bad of ['', '[', '"x"', '1', 'null']) assert.deepEqual(parsePluginTextSetting(bad, json), { error: 'Invalid JSON' }, bad);
    assert.deepEqual(parsePluginTextSetting(' line 1\nline 2 ', { type: 'string', multiline: true }), { value: 'line 1\nline 2' });
});
