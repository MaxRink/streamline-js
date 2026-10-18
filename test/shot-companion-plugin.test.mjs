import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSkinAnswer, liveEndpoint, callableEndpoint, pushWants } from '../src/modules/plugin-surfaces.js';

// plugins/shot-companion.reaplugin runs inside Decaid's plugin runtime, not the
// skin. Here it runs with a fake host and a fake Decaid REST API, and every
// `skin` answer goes through the skin's own parser: a surface the skin would
// drop fails the test instead of silently disappearing on the tablet.

const DIR = new URL('../plugins/shot-companion.reaplugin/', import.meta.url);
const SOURCE = readFileSync(new URL('plugin.js', DIR), 'utf8');
const MANIFEST = JSON.parse(readFileSync(new URL('manifest.json', DIR), 'utf8'));
const BASE = 'http://localhost:8080/api/v1';

// A fixed local noon, so "today" never straddles midnight while a test runs.
const NOON = new Date(2026, 9, 18, 12, 0, 0).getTime();
const iso = ms => new Date(ms).toISOString();

const workflowFor = (over = {}) => ({
    id: 'wf', name: 'Espresso',
    profile: { title: 'D-Flow / default', steps: [] },
    context: { targetDoseWeight: 18, targetYield: 36, grinderSetting: '6.4', coffeeName: 'Yirgacheffe',
        coffeeRoaster: 'Square Mile', beanBatchId: 'batch-1', ...over.context },
    ...(over.profile && { profile: over.profile }),
});

const shot = (id, atMs, over = {}) => ({
    id, createdAt: iso(atMs), timestamp: iso(atMs),
    workflow: { profile: { title: 'D-Flow / default' },
        context: { targetDoseWeight: 18.5, targetYield: 40, grinderSetting: '6.8', ...over.context } },
    annotations: { actualYield: 39.6, ...over.annotations },
});

const measurements = (startMs, seconds) => [
    { machine: { timestamp: iso(startMs - 3000), state: { substate: 'preparingForShot' } } },
    { machine: { timestamp: iso(startMs), state: { substate: 'preinfusion' } } },
    { machine: { timestamp: iso(startMs + seconds * 1000), state: { substate: 'pouring' } } },
];

// The default fake Decaid: one earlier shot today on this profile, one yesterday.
function defaultRoutes() {
    const last = shot('s2', NOON - 60 * 60000);
    return {
        '/workflow': () => workflowFor(),
        '/shots?limit=1': () => ({ items: [last], total: 7, limit: 1, offset: 0 }),
        '/shots?limit=100': () => ({ items: [shot('s3', NOON - 5 * 60000), last, shot('s1', NOON - 30 * 3600000)], total: 3 }),
        '/shots/s2': () => ({ ...last, measurements: measurements(NOON - 60 * 60000, 28) }),
        '/shots/s3': () => ({ ...shot('s3', NOON - 5 * 60000), measurements: measurements(NOON - 5 * 60000, 31) }),
        '/bean-batches/batch-1': () => ({ id: 'batch-1', roastDate: iso(NOON - 12 * 86400000), roastLevel: 'light', weightRemaining: 182.4 }),
    };
}

async function start(t, { routes = defaultRoutes(), settings = {} } = {}) {
    t.mock.timers.enable({ apis: ['Date'], now: NOON });
    const calls = [];
    const emits = [];
    const logs = [];
    const fetch = async (url) => {
        calls.push(url);
        assert.ok(url.startsWith(BASE), `only Decaid's own API is read: ${url}`);
        const path = url.slice(BASE.length);
        const key = Object.keys(routes).sort((a, b) => b.length - a.length).find(k => path.startsWith(k));
        if (!key) return { ok: false, status: 404, json: async () => ({}) };
        const body = routes[key](path);
        if (body instanceof Error) return { ok: false, status: 500, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => structuredClone(body) };
    };
    const host = {
        log: msg => logs.push(msg),
        emit: (name, payload) => emits.push({ name, payload }),
    };
    const createPlugin = new Function('fetch', `${SOURCE}\nreturn createPlugin;`)(fetch);
    const plugin = createPlugin(host);
    await plugin.onLoad({ LiveStrip: true, LastShotPills: true, BeanButton: true, MatchBy: 'Same profile', ...settings });
    await settle();
    return { plugin, calls, emits, logs, routes };
}

// Lets queued refreshes (microtasks only; no real timers are used) run out.
const settle = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };

async function skin(plugin) {
    const res = await plugin.__httpRequestHandler({ requestId: 'r1', endpoint: 'skin', method: 'GET', headers: {}, body: null, query: {} });
    assert.equal(res.requestId, 'r1');
    assert.equal(res.status, 200);
    assert.equal(res.headers['Content-Type'], 'application/json');
    const raw = JSON.parse(res.body);
    const parsed = parseSkinAnswer(raw);
    assert.equal(parsed.surfaces.length, raw.surfaces.length, 'the skin keeps every surface the plugin sends');
    return { raw, parsed, byId: Object.fromEntries(parsed.surfaces.map(s => [s.id, s])) };
}

test('manifest declares every endpoint the answer uses, with the permissions they need', async (t) => {
    const { plugin } = await start(t);
    const { parsed } = await skin(plugin);
    assert.equal(liveEndpoint(MANIFEST, parsed.live), 'changed');
    for (const s of parsed.surfaces) {
        if (s.action?.type === 'call') assert.ok(callableEndpoint(MANIFEST, s.action.endpoint));
        if (s.action?.type === 'open') assert.ok(MANIFEST.api.some(e => e.type === 'http' && e.id === 'ui'));
    }
    assert.ok(MANIFEST.api.some(e => e.type === 'http' && e.id === 'skin'));
    for (const p of ['api', 'emit', 'events.workflow', 'events.shots']) assert.ok(MANIFEST.permissions.includes(p), p);
    assert.equal(MANIFEST.id, plugin.id);
    assert.equal(MANIFEST.version, plugin.version);
});

test('the full answer: bean button, live strip, three pills and the result line', async (t) => {
    const { plugin } = await start(t);
    const { byId } = await skin(plugin);

    assert.deepEqual(byId.bean, { id: 'bean', kind: 'header-button', label: 'Yirgacheffe',
        text: 'Square Mile · 12 days off roast',
        action: { type: 'open', view: 'bean', presentation: 'overlay', fit: true, closeOnShot: true } });

    const strip = byId.strip;
    assert.equal(strip.show, 'shot');
    assert.deepEqual(strip.cells.map(c => [c.cell || c.label, c.col, c.span]),
        [['weight', 1, 2], ['pressure', 3, 2], ['flow', 5, 2], ['step', 7, 2], ['Today', 9, 1]]);
    assert.equal(strip.cells[0].bar, true);
    assert.ok(strip.cells[1].dot && strip.cells[2].dot, 'pressure and flow are judged against the profile');
    assert.equal(strip.cells[4].text, '#3', 'two shots so far today, so this is the third');

    assert.deepEqual([byId['last-grind'].text, byId['last-grind'].action],
        ['Last 6.8', { type: 'set', field: 'grinderSetting', value: 6.8 }]);
    assert.deepEqual([byId['last-dose'].text, byId['last-dose'].action],
        ['Last 18.5g', { type: 'set', field: 'targetDoseWeight', value: 18.5 }]);
    assert.deepEqual([byId['last-yield'].text, byId['last-yield'].action],
        ['Last 40g', { type: 'set', field: 'targetYield', value: 40 }]);
    assert.match(byId['last-grind'].title, /^Last D-Flow \/ default shot, 1 h ago$/);
    assert.equal(byId['last-result'].kind, 'tile-line');
    assert.equal(byId['last-result'].text, '39.6g · 28s');
});

test('a pill is marked active when the tile already holds that value', async (t) => {
    const routes = defaultRoutes();
    routes['/workflow'] = () => workflowFor({ context: { grinderSetting: '6.8', targetDoseWeight: 18.5 } });
    const { plugin } = await start(t, { routes });
    const { byId } = await skin(plugin);
    assert.equal(byId['last-grind'].active, true);
    assert.equal(byId['last-dose'].active, true);
    assert.equal(byId['last-yield'].active, undefined);
});

test('older shot records (doseData, grinderData) and microsecond, zone-less timestamps', async (t) => {
    const routes = defaultRoutes();
    const d = new Date(NOON - 150 * 60000);
    const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T`
        + `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:00.471700`;
    const legacy = { id: 'old', timestamp: local,
        workflow: { profile: { title: 'D-Flow / default' }, doseData: { doseIn: 17, doseOut: 34 }, grinderData: { setting: '12' } } };
    routes['/shots?limit=1'] = () => ({ items: [legacy], total: 1 });
    routes['/shots/old'] = () => ({ ...legacy, measurements: [] });
    const { plugin } = await start(t, { routes });
    const { byId } = await skin(plugin);
    assert.equal(byId['last-grind'].text, 'Last 12');
    assert.equal(byId['last-dose'].text, 'Last 17g');
    assert.equal(byId['last-yield'].text, 'Last 34g');
    assert.match(byId['last-grind'].title, /2 h ago$/);
    assert.equal(byId['last-result'], undefined, 'no actual yield and no measurements: no result line');
});

test('values outside what the tile accepts are not offered', async (t) => {
    const routes = defaultRoutes();
    routes['/shots?limit=1'] = () => ({ items: [shot('s9', NOON - 60000, { context: { targetDoseWeight: 45, grinderSetting: 'fine' } })] });
    routes['/shots/s9'] = () => ({ measurements: [] });
    const { plugin } = await start(t, { routes });
    const { byId } = await skin(plugin);
    assert.equal(byId['last-dose'], undefined);
    assert.equal(byId['last-grind'], undefined);
    assert.ok(byId['last-yield']);
});

test('"Same coffee" filters by the coffee and falls back to the profile without one', async (t) => {
    const { calls, plugin } = await start(t, { settings: { MatchBy: 'Same coffee' } });
    assert.ok(calls.some(u => u.includes('/shots?limit=1') && u.includes('coffeeName=Yirgacheffe')));
    const { byId } = await skin(plugin);
    assert.match(byId['last-grind'].title, /^Last Yirgacheffe shot/);

    plugin.onEvent({ name: 'workflowUpdated', payload: workflowFor({ context: { coffeeName: null, beanBatchId: null } }) });
    await settle();
    assert.ok(calls.some(u => u.includes('/shots?limit=1') && u.includes('profileTitle=D-Flow%20%2F%20default')));
    const after = await skin(plugin);
    assert.equal(after.byId.bean, undefined, 'no coffee on the workflow: no bean button');
});

test('a new profile re-reads the last shot and pushes once; an unchanged workflow does not push', async (t) => {
    const routes = defaultRoutes();
    const { plugin, calls, emits } = await start(t, { routes });
    await skin(plugin);
    const before = emits.length;

    plugin.onEvent({ name: 'workflowUpdated', payload: workflowFor() });
    await settle();
    assert.equal(emits.length, before, 'same answer: no push');

    routes['/shots?limit=1'] = () => ({ items: [shot('s7', NOON - 120000, { context: { grinderSetting: '9' } })] });
    routes['/shots/s7'] = () => ({ measurements: [] });
    plugin.onEvent({ name: 'workflowUpdated', payload: workflowFor({ profile: { title: 'Blooming' } }) });
    await settle();
    assert.ok(calls.some(u => u.includes('profileTitle=Blooming')));
    assert.equal(emits.length, before + 1);
    assert.deepEqual(emits.at(-1), { name: 'changed', payload: { what: 'skin' } });
    assert.deepEqual(pushWants(JSON.stringify(emits.at(-1).payload)), { skin: true, workflow: false });
    assert.equal((await skin(plugin)).byId['last-grind'].text, 'Last 9');
});

test('a stored shot updates the count and the recall', async (t) => {
    const routes = defaultRoutes();
    const { plugin, emits } = await start(t, { routes });
    await skin(plugin);
    const newest = shot('s4', NOON - 10000, { context: { grinderSetting: '7' } });
    routes['/shots?limit=1'] = () => ({ items: [newest] });
    routes['/shots?limit=100'] = () => ({ items: [newest, shot('s3', NOON - 5 * 60000), shot('s2', NOON - 3600000)] });
    routes['/shots/s4'] = () => ({ measurements: measurements(NOON - 40000, 30) });
    plugin.onEvent({ name: 'shotStored', payload: { id: 's4' } });
    await settle();
    assert.equal(emits.at(-1).name, 'changed');
    const { byId } = await skin(plugin);
    assert.equal(byId.strip.cells.find(c => c.label === 'Today').text, '#4');
    assert.equal(byId['last-grind'].text, 'Last 7');
    assert.equal(byId['last-result'].text, '39.6g · 30s');
});

test('a full page of today\'s shots shows a lower bound', async (t) => {
    const routes = defaultRoutes();
    routes['/shots?limit=100'] = () => ({ items: Array.from({ length: 100 }, (_, i) => shot(`t${i}`, NOON - (i + 1) * 60000)) });
    const { plugin } = await start(t, { routes });
    const { byId } = await skin(plugin);
    assert.equal(byId.strip.cells.find(c => c.label === 'Today').text, '#101+');
});

test('Decaid errors leave a smaller answer, never a broken one', async (t) => {
    const fail = () => new Error('down');
    const routes = { '/workflow': fail, '/shots': fail, '/bean-batches': fail };
    const { plugin, logs } = await start(t, { routes });
    const { raw, byId } = await skin(plugin);
    assert.deepEqual(raw.surfaces.map(s => s.id), ['strip']);
    assert.deepEqual(byId.strip.cells.map(c => [c.cell, c.col, c.span]),
        [['weight', 1, 2], ['pressure', 3, 2], ['flow', 5, 2], ['step', 7, 3]]);
    assert.ok(logs.length > 0);
});

test('each part can be switched off', async (t) => {
    const { plugin, calls } = await start(t, { settings: { LiveStrip: false, LastShotPills: 'false', BeanButton: false } });
    const { raw } = await skin(plugin);
    assert.deepEqual(raw.surfaces, []);
    assert.deepEqual(raw.live, { endpoint: 'changed' });
    assert.ok(!calls.some(u => u.includes('/shots')), 'nothing switched on, nothing read');
});

test('other endpoints answer 404', async (t) => {
    const { plugin } = await start(t);
    const res = await plugin.__httpRequestHandler({ requestId: 'x', endpoint: 'apply', headers: {}, query: {} });
    assert.equal(res.status, 404);
});

// ── The bean card (the header button's overlay page) ──────────────────────────

async function card(plugin, headers = {}, query = { embed: '1', theme: 'light', view: 'bean' }) {
    const res = await plugin.__httpRequestHandler({ requestId: 'c', endpoint: 'ui', method: 'GET', headers, body: null, query });
    assert.equal(res.status, 200);
    assert.match(res.headers['Content-Type'], /^text\/html/);
    return res;
}

test('the bean card shows the batch and the last shot with this coffee', async (t) => {
    const { plugin, calls } = await start(t);
    const res = await card(plugin);
    assert.ok(calls.some(u => u.includes('coffeeName=Yirgacheffe')));
    for (const piece of ['<h1>Yirgacheffe</h1>', 'Square Mile', '12 days ago', 'light', '182 g', '<b>7</b>',
        '1 h ago', 'D-Flow / default', '6.8', '18.5 g → 39.6 g', '28 s']) {
        assert.ok(res.body.includes(piece), `card shows ${piece}`);
    }
    assert.match(res.body, /streamline:ready/);
    assert.match(res.body, /streamline:size/);
    assert.match(res.body, /streamline:close/);
    assert.doesNotMatch(res.body, /color-scheme/, 'a dark color-scheme would paint an opaque canvas');
});

test('the bean card escapes text from Decaid', async (t) => {
    const routes = defaultRoutes();
    routes['/workflow'] = () => workflowFor({ context: { coffeeName: '<img src=x onerror=alert(1)>', coffeeRoaster: '"R&D"' } });
    routes['/shots?limit=1'] = () => ({ items: [], total: 0 });
    const { plugin } = await start(t, { routes });
    const res = await card(plugin);
    assert.ok(!res.body.includes('<img'));
    assert.ok(res.body.includes('&lt;img src=x onerror=alert(1)&gt;'));
    assert.ok(res.body.includes('&quot;R&amp;D&quot;'));
});

test('the bean card may be framed by the skin\'s origin only', async (t) => {
    const { plugin } = await start(t);
    assert.equal((await card(plugin, { Referer: 'http://192.168.1.20:3000/index.html' })).headers['Content-Security-Policy'],
        "frame-ancestors 'self' http://192.168.1.20:3000");
    assert.equal((await card(plugin, { origin: 'http://localhost:8044' })).headers['Content-Security-Policy'],
        "frame-ancestors 'self' http://localhost:8044");
    assert.equal((await card(plugin, { referer: "javascript:alert(1)" })).headers['Content-Security-Policy'], "frame-ancestors 'self'");
    assert.equal((await card(plugin, { referer: "http://a.b; script-src *" })).headers['Content-Security-Policy'], "frame-ancestors 'self'");
});

test('the bean card without a coffee says how to get one', async (t) => {
    const routes = defaultRoutes();
    routes['/workflow'] = () => workflowFor({ context: { coffeeName: '', beanBatchId: null } });
    const { plugin } = await start(t, { routes });
    const res = await card(plugin, {}, { theme: 'dark' });
    assert.ok(res.body.includes('Choose a coffee for this workflow'));
    assert.ok(res.body.includes('#1f2328'), 'dark theme');
});
