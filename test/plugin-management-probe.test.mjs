import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('../src/modules/api.js', import.meta.url), 'utf8');
const pick = pattern => {
    const match = source.match(pattern);
    assert.ok(match, `${pattern} not found in api.js`);
    return match[0].replace('export ', '');
};
const functionSource = [
    pick(/const PLUGIN_MANAGEMENT_PROBE_TTL_MS[\s\S]*?\r?\nexport function probePluginManagement\(\) \{[\s\S]*?\r?\n\}/),
    pick(/export async function setPluginSettings\(pluginId, settings\) \{[\s\S]*?\r?\n\}/),
    pick(/function pluginEndpointError\(pluginId, endpoint, status, errorBody\) \{[\s\S]*?\r?\n\}/),
].join('\n');

const E64 = 'mahlkoenig-e64.reaplugin';
const PROBE_KEY = '__streamline_probe__';
const settingRejected = key => JSON.stringify({ error: `Setting "${key}" not defined in plugin manifest` });

function createApi({ probeStatus = 400, saveStatus = 200, saveBody = '{}', unreachable = false } = {}) {
    const clock = { now: 0 };
    const posts = [];
    const fetch = async (url, init) => {
        if (unreachable) { posts.push(url); throw new TypeError('Failed to fetch'); }
        posts.push({ url, body: JSON.parse(init.body) });
        const isProbe = PROBE_KEY in JSON.parse(init.body);
        const status = isProbe ? probeStatus : saveStatus;
        return { ok: status < 400, status, text: async () => (isProbe ? settingRejected(PROBE_KEY) : saveBody) };
    };
    const api = new Function(
        'fetch', 'logger', 'API_BASE_URL', 'getPlugins', 'pluginManagementProbeTarget', 'PLUGIN_MANAGEMENT_PROBE_KEY', 'Date', 'document', 'CustomEvent',
        `${functionSource}\nreturn { probePluginManagement, setPluginSettings };`,
    )(
        fetch, { info() {}, error() {} }, 'http://decaid/api/v1',
        async () => [{ id: E64, settings: { AllowControl: { type: 'enum' } } }],
        plugins => plugins[0].id, PROBE_KEY,
        { now: () => clock.now }, { dispatchEvent() {} }, class { constructor(type) { this.type = type; } },
    );
    return { api, posts, clock };
}

test('the management probe is the 400 the host logs: an unknown key POSTed to the first plugin with settings', async () => {
    const { api, posts } = createApi();
    assert.equal(await api.probePluginManagement(), 400);
    assert.deepEqual(posts, [{ url: `http://decaid/api/v1/plugins/${encodeURIComponent(E64)}/settings`, body: { [PROBE_KEY]: null } }]);
});

test('opening plugin pages one after another reuses the probe instead of posting a 400 per page', async () => {
    const { api, posts, clock } = createApi();
    for (let page = 0; page < 10; page += 1) {
        assert.equal(await api.probePluginManagement(), 400);
        clock.now += 10_000;
    }
    assert.equal(posts.length, 1);
    clock.now = 5 * 60 * 1000;
    await api.probePluginManagement();
    assert.equal(posts.length, 2);
});

test('a probe that could not reach the host is not remembered', async () => {
    const { api, posts } = createApi({ unreachable: true });
    assert.equal(await api.probePluginManagement(), null);
    assert.equal(await api.probePluginManagement(), null);
    assert.equal(posts.length, 2);
});

test('a rejected save shows the host\'s reason, not the raw response', async () => {
    const { api } = createApi({ saveStatus: 400, saveBody: JSON.stringify({ error: 'Setting "AdjustmentOwner" must be one of: off, grinder, decaid' }) });
    await assert.rejects(api.setPluginSettings(E64, { AdjustmentOwner: 'nope' }), error => {
        assert.equal(error.message, 'Setting "AdjustmentOwner" must be one of: off, grinder, decaid');
        assert.equal(error.status, 400);
        return true;
    });
});

test('a save refused for authorization drops the remembered probe so the next page asks again', async () => {
    const { api, posts } = createApi({ saveStatus: 401, saveBody: JSON.stringify({ error: 'Missing or malformed bearer token' }) });
    await api.probePluginManagement();
    await assert.rejects(api.setPluginSettings(E64, { AllowControl: 'true' }), /Missing or malformed bearer token/);
    await api.probePluginManagement();
    assert.equal(posts.filter(post => PROBE_KEY in post.body).length, 2);
});
