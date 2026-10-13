import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createScaleInfoLifecycle, getScaleDeviceSetting, hasSkaleUsbSetting, shouldInvalidateScaleInfoAfterWrite } from '../src/settings/scale-device-details.js';

const source = readFileSync(
    new URL('../src/settings/settings.js', import.meta.url),
    'utf8',
);
const apiSource = readFileSync(new URL('../src/modules/api.js', import.meta.url), 'utf8');

function extractFunction(name) {
    const start = source.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `${name} was not found`);
    let depth = 0;
    let bodyStarted = false;
    for (let index = source.indexOf('{', start); index < source.length; index += 1) {
        if (source[index] === '{') {
            depth += 1;
            bodyStarted = true;
        } else if (source[index] === '}') {
            depth -= 1;
            if (bodyStarted && depth === 0) {
                return source.slice(start, index + 1);
            }
        }
    }
    throw new Error(`Could not extract ${name}`);
}

function extractAssignedFunction(name) {
    const start = source.indexOf(`window.${name} = `);
    assert.notEqual(start, -1, `${name} was not found`);
    let depth = 0;
    let bodyStarted = false;
    for (let index = source.indexOf('{', start); index < source.length; index += 1) {
        if (source[index] === '{') {
            depth += 1;
            bodyStarted = true;
        } else if (source[index] === '}') {
            depth -= 1;
            if (bodyStarted && depth === 0) {
                return (source.slice(start, source.indexOf('function', start)).includes('async') ? 'async ' : '') + source.slice(source.indexOf('function', start), index + 1);
            }
        }
    }
    throw new Error(`Could not extract ${name}`);
}

function loadScaleDeviceSetting() {
    return getScaleDeviceSetting;
}

function loadScaleInfoLifecycle({ getScaleInfo, deviceStateCache, renderDeviceListFromCache = () => {} }) {
    return createScaleInfoLifecycle({
        getScaleInfo,
        getDeviceState: () => deviceStateCache,
        renderDeviceListFromCache,
        logger: { warn() {}, debug() {} },
    });
}

function loadRenderSingleDeviceList({
    scaleInfoByDeviceId,
    usbPoweredByDevice = undefined,
    legacyUsbPowered = undefined,
    latestBattery = undefined,
    pendingChanges = { rea: {} },
    getTranslation = value => value,
}) {
    const render = extractFunction('renderSingleDeviceList');
    const getScaleDeviceSetting = loadScaleDeviceSetting();
    return new Function(
        'scaleInfoByDeviceId',
        'settingsCache',
        'pendingChanges',
        'renderBatteryBadge',
        'escapeHtml',
        'getTranslation',
        'renderScalePopupToggle',
        'getScaleDeviceSetting',
        'window',
        `const hasSkaleUsbSetting = ${hasSkaleUsbSetting.toString()};\n${render}\nreturn renderSingleDeviceList;`,
    )(
        scaleInfoByDeviceId,
        {
            rea: {
                ...(usbPoweredByDevice !== undefined
                    ? { skalePoweredByUsbByDevice: usbPoweredByDevice }
                    : {}),
                ...(legacyUsbPowered !== undefined
                    ? { skalePoweredByUsb: legacyUsbPowered }
                    : {}),
            },
        },
        pendingChanges,
        level => `<battery>${level}</battery>`,
        value => String(value),
        getTranslation,
        () => '',
        getScaleDeviceSetting,
        { getLatestScaleBattery: () => latestBattery },
    );
}

function deferred() {
    let resolve;
    const promise = new Promise(result => { resolve = result; });
    return { promise, resolve };
}

test('repeated renders share one in-flight scale info request', async () => {
    const pending = deferred();
    let calls = 0;
    const deviceStateCache = { devices: [{ id: 'A', state: 'connected' }] };
    const lifecycle = loadScaleInfoLifecycle({
        deviceStateCache,
        getScaleInfo: () => {
            calls += 1;
            return pending.promise;
        },
    });

    const first = lifecycle.refreshScaleInfo('A');
    const second = lifecycle.refreshScaleInfo('A');
    assert.equal(calls, 1);
    pending.resolve({ firmwareVersion: 'R029' });
    await Promise.all([first, second]);
    assert.deepEqual(lifecycle.scaleInfoByDeviceId.get('A'), { firmwareVersion: 'R029' });
});

test('scale info is fenced across A to B to A and disconnect transitions', async () => {
    const requests = [];
    const deviceStateCache = { devices: [{ id: 'A', state: 'connected' }] };
    const lifecycle = loadScaleInfoLifecycle({
        deviceStateCache,
        getScaleInfo: () => {
            const request = deferred();
            requests.push(request);
            return request.promise;
        },
    });

    const firstA = lifecycle.refreshScaleInfo('A');
    deviceStateCache.devices = [{ id: 'B', state: 'connected' }];
    const b = lifecycle.refreshScaleInfo('B');
    deviceStateCache.devices = [{ id: 'A', state: 'connected' }];
    const secondA = lifecycle.refreshScaleInfo('A');
    assert.equal(requests.length, 3);

    requests[0].resolve({ firmwareVersion: 'stale-A' });
    requests[1].resolve({ firmwareVersion: 'stale-B' });
    await Promise.all([firstA, b]);
    assert.equal(lifecycle.scaleInfoByDeviceId.has('A'), false);
    assert.equal(lifecycle.scaleInfoByDeviceId.has('B'), false);

    requests[2].resolve({ firmwareVersion: 'fresh-A' });
    await secondA;
    assert.deepEqual(lifecycle.scaleInfoByDeviceId.get('A'), { firmwareVersion: 'fresh-A' });

    deviceStateCache.devices = [];
    await lifecycle.refreshScaleInfo(null);
    assert.equal(lifecycle.scaleInfoByDeviceId.size, 0);
});

test('an unavailable scale-info endpoint leaves metadata unknown', async () => {
    const deviceStateCache = { devices: [{ id: 'A', state: 'connected' }] };
    const lifecycle = loadScaleInfoLifecycle({
        deviceStateCache,
        getScaleInfo: async () => {
            const error = new Error('endpoint unavailable');
            error.status = 503;
            throw error;
        },
    });

    await lifecycle.refreshScaleInfo('A');
    assert.deepEqual(lifecycle.scaleInfoByDeviceId.get('A'), {});
});

test('scale-info failures are cached and retried only after the backoff', async () => {
    let calls = 0;
    let now = 1000;
    const lifecycle = createScaleInfoLifecycle({
        getDeviceState: () => ({ devices: [{ id: 'A', state: 'connected' }] }),
        now: () => now,
        getScaleInfo: async () => {
            calls += 1;
            const error = new Error('offline');
            error.status = 500;
            throw error;
        },
    });
    await lifecycle.refreshScaleInfo('A');
    await lifecycle.refreshScaleInfo('A');
    assert.equal(calls, 1);
    now += 30_000;
    await lifecycle.refreshScaleInfo('A');
    assert.equal(calls, 2);
});

test('scale-info does not fetch while the settings list is unmounted', async () => {
    let calls = 0;
    const lifecycle = createScaleInfoLifecycle({
        isMounted: () => false,
        getDeviceState: () => ({ devices: [{ id: 'A', state: 'connected' }] }),
        getScaleInfo: async () => { calls += 1; return {}; },
    });
    await lifecycle.refreshScaleInfo('A');
    assert.equal(calls, 0);
});

test('the settings module remains syntactically valid as an ES module', () => {
    execFileSync(process.execPath, ['--input-type=module', '--check'], {
        input: source,
        stdio: ['pipe', 'pipe', 'pipe'],
    });
});

test('stale metadata is not rendered for disconnected scales or unknown batteries', () => {
    const metadata = new Map([['A', { firmwareVersion: 'R029', batteryLevel: null }]]);
    const render = loadRenderSingleDeviceList({ scaleInfoByDeviceId: metadata });
    const html = render([{ id: 'A', name: 'Scale A', state: 'disconnected' }], '', '', 'Scale');
    assert.doesNotMatch(html, /R029|77/);

    const connectedHtml = render([{ id: 'A', name: 'Scale A', state: 'connected' }], '', '', 'Scale');
    assert.doesNotMatch(connectedHtml, /77/);
});

test('USB power state is rendered from the per-device setting and suppresses battery', () => {
    const metadata = new Map([['A', { firmwareVersion: 'R029', batteryLevel: 77 }]]);
    const render = loadRenderSingleDeviceList({
        scaleInfoByDeviceId: metadata,
        usbPoweredByDevice: { A: true },
    });

    const html = render([{ id: 'A', name: 'Scale A', state: 'connected' }], '', '', 'Scale');
    assert.match(html, />USB</);
    assert.doesNotMatch(html, /<battery>77<\/battery>/);
});

test('staged USB power is visibly distinguished until save', () => {
    const render = loadRenderSingleDeviceList({
        scaleInfoByDeviceId: new Map([['A', { batteryLevel: 77 }]]),
        usbPoweredByDevice: { A: true },
        pendingChanges: { rea: { skalePoweredByUsbByDevice: { A: true } } },
    });
    const html = render([{ id: 'A', name: 'Scale A', state: 'connected' }], '', '', 'Scale');
    assert.match(html, />USB \(pending\)</);
});

test('native USB control remains absent when the backend does not expose it', () => {
    const metadata = new Map([['A', { firmwareVersion: 'R029', batteryLevel: 77 }]]);
    const render = loadRenderSingleDeviceList({ scaleInfoByDeviceId: metadata });
    const html = render([{ id: 'A', name: 'Scale A', state: 'connected' }], '', '', 'Scale');
    assert.doesNotMatch(html, />USB</);
    assert.match(html, /<battery>77<\/battery>/);
});

test('USB badge and battery return to the live metadata path when the map disables the device', () => {
    const metadata = new Map([['A', { firmwareVersion: 'R029', batteryLevel: 77 }]]);
    const render = loadRenderSingleDeviceList({
        scaleInfoByDeviceId: metadata,
        usbPoweredByDevice: { A: false },
    });

    const html = render([{ id: 'A', name: 'Scale A', state: 'connected' }], '', '', 'Scale');
    assert.doesNotMatch(html, />USB</);
    assert.match(html, /<battery>77<\/battery>/);
});

test('a legacy USB key does not enable controls or suppress battery metadata', () => {
    const render = loadRenderSingleDeviceList({
        scaleInfoByDeviceId: new Map([['A', { batteryLevel: 77 }]]),
        legacyUsbPowered: true,
    });
    const html = render([{ id: 'A', name: 'Skale 2', state: 'connected' }], '', 'preferredScaleId', 'Scale');
    assert.doesNotMatch(html, />USB<|openScaleDeviceSettings/);
    assert.match(html, /<battery>77<\/battery>/);
    assert.match(html, /setPreferredDevice/);
});

test('per-device USB settings remain independent for both enabled and disabled devices', () => {
    const metadata = new Map([
        ['A', { firmwareVersion: 'R029', batteryLevel: 77 }],
        ['B', { firmwareVersion: 'R029', batteryLevel: 66 }],
    ]);
    const render = loadRenderSingleDeviceList({
        scaleInfoByDeviceId: metadata,
        usbPoweredByDevice: { A: true },
    });
    const html = render([
        { id: 'A', name: 'Scale A', state: 'connected' },
        { id: 'B', name: 'Scale B', state: 'connected' },
    ], '', '', 'Scale');
    const a = html.slice(html.indexOf('Scale A'), html.indexOf('Scale B'));
    const b = html.slice(html.indexOf('Scale B'));
    assert.match(a, />USB</);
    assert.doesNotMatch(a, /<battery>77<\/battery>/);
    assert.doesNotMatch(b, />USB</);
    assert.match(b, /<battery>66<\/battery>/);
});

function loadUpdateScaleDeviceSetting({
    settingsCache,
    updateReaSetting,
    renderDeviceListFromCache = () => {},
    scaleInfoByDeviceId = new Map(),
    devices = [{ id: 'A', name: 'Skale A' }, { id: 'B', name: 'Skale B' }],
}) {
    const update = extractAssignedFunction('updateScaleDeviceSetting');
    return new Function(
        'settingsCache',
        'scaleInfoByDeviceId',
        'renderDeviceListFromCache',
        'updateReaSetting',
        'deviceStateCache',
        `const hasSkaleUsbSetting = ${hasSkaleUsbSetting.toString()};
         const updateScaleDeviceSetting = ${update};\nreturn updateScaleDeviceSetting;`,
    )(
        settingsCache,
        scaleInfoByDeviceId,
        renderDeviceListFromCache,
        updateReaSetting,
        { devices },
    );
}

test('staging USB changes updates only the selected device and waits for save before repainting', () => {
    const scaleInfoByDeviceId = new Map([
        ['A', { firmwareVersion: 'R029', batteryLevel: 77 }],
        ['B', { firmwareVersion: 'R029', batteryLevel: 66 }],
    ]);
    const settingsCache = { rea: { skalePoweredByUsbByDevice: { A: true, B: true } } };
    let renderCount = 0;
    const staged = [];
    const update = loadUpdateScaleDeviceSetting({
        settingsCache,
        scaleInfoByDeviceId,
        renderDeviceListFromCache: () => { renderCount += 1; },
        updateReaSetting: (key, value) => {
            staged.push({ key, value });
            settingsCache.rea[key] = value;
        },
    });

    update('B', false);
    assert.deepEqual(settingsCache.rea.skalePoweredByUsbByDevice, { A: true });
    assert.equal(renderCount, 0);
    assert.deepEqual(staged, [{
        key: 'skalePoweredByUsbByDevice',
        value: { A: true },
    }]);
    assert.deepEqual(scaleInfoByDeviceId.get('B'), { firmwareVersion: 'R029', batteryLevel: 66 });
});

test('unsupported hosts and non-Skale devices cannot stage USB changes', () => {
    for (const [settings, name] of [
        [{}, 'Skale 2'],
        [{ skalePoweredByUsb: false }, 'Skale 2'],
        [{ skalePoweredByUsbByDevice: {} }, 'Acaia'],
    ]) {
        const staged = [];
        const update = loadUpdateScaleDeviceSetting({
            settingsCache: { rea: settings }, devices: [{ id: 'A', name }],
            updateReaSetting: (...args) => staged.push(args),
        });
        update('A', true);
        assert.deepEqual(staged, []);
    }
});

function loadFlushPendingChanges({
    pendingChanges,
    setReaSettings,
    scaleInfoByDeviceId = new Map(),
    scaleInfoInFlight = new Map(),
    saveSettingsBackup = () => {},
    setDe1Settings = async () => {},
    renderDeviceListFromCache = () => {},
}) {
    const flush = extractFunction('flushPendingChanges');
    return new Function(
        'pendingChanges',
        'setReaSettings',
        'scaleInfoByDeviceId',
        'scaleInfoInFlight',
        'saveSettingsBackup',
        'setDe1Settings',
        'renderDeviceListFromCache',
        `let scaleInfoRequestGeneration = 0;
         const invalidateScaleInfo = () => {
             scaleInfoRequestGeneration += 1;
             scaleInfoByDeviceId.clear();
             scaleInfoInFlight.clear();
         };
         const shouldInvalidateScaleInfoAfterWrite = ${shouldInvalidateScaleInfoAfterWrite.toString()};
         function resetPendingChanges() {
             pendingChanges.rea = {};
             pendingChanges.de1 = {};
             pendingChanges.de1Advanced = {};
             pendingChanges.workflow = {};
         }
         async ${flush}
         return {
             flushPendingChanges,
             get generation() { return scaleInfoRequestGeneration; },
         };`,
    )(
        pendingChanges,
        setReaSettings,
        scaleInfoByDeviceId,
        scaleInfoInFlight,
        saveSettingsBackup,
        setDe1Settings,
        renderDeviceListFromCache,
    );
}

function loadScaleInfoAndSaveLifecycle({
    getScaleInfo,
    deviceStateCache,
    setReaSettings,
}) {
    const flush = extractFunction('flushPendingChanges');
    const lifecycle = createScaleInfoLifecycle({
        getScaleInfo,
        getDeviceState: () => deviceStateCache,
        logger: { warn() {}, debug() {} },
    });
    return new Function(
        'lifecycle',
        'logger',
        'setReaSettings',
        'saveSettingsBackup',
        `function renderDeviceListFromCache() {}
         let pendingChanges = { rea: {}, de1: {}, de1Advanced: {}, workflow: {} };
         function resetPendingChanges() {
             pendingChanges = { rea: {}, de1: {}, de1Advanced: {}, workflow: {} };
         }
         async ${flush}
         const refreshScaleInfo = lifecycle.refreshScaleInfo;
         const scaleInfoByDeviceId = lifecycle.scaleInfoByDeviceId;
         const scaleInfoInFlight = lifecycle.scaleInfoInFlight;
         const invalidateScaleInfo = lifecycle.invalidate;
         const shouldInvalidateScaleInfoAfterWrite = ${shouldInvalidateScaleInfoAfterWrite.toString()};
         return {
             refreshScaleInfo,
             scaleInfoByDeviceId,
             stageUsbSetting(value) {
                 pendingChanges.rea.skalePoweredByUsbByDevice = value;
             },
             flushPendingChanges,
         };`,
    )(
        lifecycle,
        { warn() {}, debug() {} },
        setReaSettings,
        () => {},
    );
}

test('successful USB save invalidates stale scale metadata requests', async () => {
    const scaleInfoByDeviceId = new Map([['A', { firmwareVersion: 'stale' }]]);
    const staleRequest = { marker: true };
    const scaleInfoInFlight = new Map([['A', staleRequest]]);
    const pendingChanges = { rea: { skalePoweredByUsbByDevice: { A: true } }, de1: {}, de1Advanced: {}, workflow: {} };
    const flush = loadFlushPendingChanges({
        pendingChanges,
        scaleInfoByDeviceId,
        scaleInfoInFlight,
        setReaSettings: async changes => {
            assert.deepEqual(changes, { skalePoweredByUsbByDevice: { A: true } });
        },
    });

    const generation = flush.generation;
    await flush.flushPendingChanges();
    assert.equal(flush.generation, generation + 1);
    assert.equal(scaleInfoByDeviceId.size, 0);
    assert.equal(scaleInfoInFlight.size, 0);
    assert.deepEqual(pendingChanges.rea, {});
});

test('successful save fences an old response before accepting the fresh refetch', async () => {
    const requests = [];
    const lifecycle = loadScaleInfoAndSaveLifecycle({
        deviceStateCache: { devices: [{ id: 'A', state: 'connected' }] },
        getScaleInfo: () => {
            const request = deferred();
            requests.push(request);
            return request.promise;
        },
        setReaSettings: async () => {},
    });

    const oldResponse = lifecycle.refreshScaleInfo('A');
    lifecycle.stageUsbSetting({ A: true });
    await lifecycle.flushPendingChanges();
    const freshResponse = lifecycle.refreshScaleInfo('A');
    assert.equal(requests.length, 2);

    requests[0].resolve({ firmwareVersion: 'stale' });
    await oldResponse;
    assert.equal(lifecycle.scaleInfoByDeviceId.has('A'), false);

    requests[1].resolve({ firmwareVersion: 'fresh' });
    await freshResponse;
    assert.deepEqual(lifecycle.scaleInfoByDeviceId.get('A'), { firmwareVersion: 'fresh' });
});

test('failed save preserves metadata until the setting is actually persisted', async () => {
    const scaleInfoByDeviceId = new Map([['A', { firmwareVersion: 'live' }]]);
    const scaleInfoInFlight = new Map([['A', { marker: true }]]);
    const pendingChanges = { rea: { skalePoweredByUsbByDevice: { A: true } }, de1: {}, de1Advanced: {}, workflow: {} };
    const flush = loadFlushPendingChanges({
        pendingChanges,
        scaleInfoByDeviceId,
        scaleInfoInFlight,
        setReaSettings: async () => { throw new Error('save failed'); },
    });

    await assert.rejects(flush.flushPendingChanges(), /save failed/);
    assert.deepEqual(scaleInfoByDeviceId.get('A'), { firmwareVersion: 'live' });
    assert.equal(scaleInfoInFlight.size, 1);
    assert.deepEqual(pendingChanges.rea, { skalePoweredByUsbByDevice: { A: true } });
});

test('scale setting helper reads only the per-device USB map', () => {
    const getSetting = loadScaleDeviceSetting();
    const settings = { skalePoweredByUsbByDevice: { A: true }, skalePoweredByUsb: true };
    assert.equal(getSetting(settings, 'skalePoweredByUsbByDevice', 'A'), true);
    assert.equal(getSetting(settings, 'skalePoweredByUsbByDevice', 'B'), false);
    assert.equal(getSetting({ skalePoweredByUsb: true }, 'skalePoweredByUsbByDevice', 'A'), undefined);
});

for (const reaFinishesFirst of [true, false]) {
    test(`successful USB write invalidates metadata despite DE1 failure (REA first: ${reaFinishesFirst})`, async () => {
        const rea = deferred();
        let rejectDe1;
        const de1 = new Promise((_, reject) => { rejectDe1 = reject; });
        const metadata = new Map([['A', { batteryLevel: 77 }]]);
        const inFlight = new Map([['A', {}]]);
        let renders = 0;
        const pendingChanges = { rea: { skalePoweredByUsbByDevice: { A: true } }, de1: { steamTemp: 130 }, de1Advanced: {}, workflow: {} };
        const flush = loadFlushPendingChanges({
            pendingChanges, scaleInfoByDeviceId: metadata, scaleInfoInFlight: inFlight,
            setReaSettings: () => rea.promise, setDe1Settings: () => de1,
            renderDeviceListFromCache: () => { renders += 1; },
        });
        const saved = flush.flushPendingChanges();
        const rejected = assert.rejects(saved, /DE1 unavailable/);
        if (reaFinishesFirst) { rea.resolve(); await rea.promise; }
        rejectDe1(new Error('DE1 unavailable'));
        await rejected;
        if (!reaFinishesFirst) {
            assert.equal(metadata.size, 1);
            rea.resolve(); await rea.promise;
        }
        assert.equal(metadata.size, 0);
        assert.equal(inFlight.size, 0);
        assert.equal(flush.generation, 1);
        assert.equal(renders, 1);
        assert.deepEqual(pendingChanges.de1, { steamTemp: 130 });
    });
}

test('every scale keeps inline Preferred while only supported Skale devices show Settings', () => {
    for (const usbPoweredByDevice of [undefined, {}, null, []]) {
        const render = loadRenderSingleDeviceList({ scaleInfoByDeviceId: new Map(), usbPoweredByDevice });
        for (const [id, name] of [['A', 'Skale 2'], ['B', 'Acaia Lunar']]) {
            const html = render([{ id, name, state: 'connected' }], id, 'preferredScaleId', 'Scale');
            assert.match(html, /onchange="window.setPreferredDevice/);
            assert.match(html, /aria-label="Preferred"/);
            assert.match(html, /checked/);
            assert.equal(html.includes('openScaleDeviceSettings'), name === 'Skale 2' && usbPoweredByDevice !== undefined && usbPoweredByDevice !== null && !Array.isArray(usbPoweredByDevice));
        }
    }
});

test('Preferred preserves the existing updateReaSetting call behavior', async () => {
    const calls = [];
    let renders = 0;
    const setPreferred = new Function('window', 'renderDeviceListFromCache', 'logger',
        `return (${extractAssignedFunction('setPreferredDevice')});`)(
        { updateReaSetting: (...args) => calls.push(args) }, () => { renders += 1; }, { error() {} });
    await setPreferred('preferredScaleId', 'A', true);
    await setPreferred('preferredMachineId', 'B', false);
    assert.deepEqual(calls, [['preferredScaleId', 'A'], ['preferredMachineId', null]]);
    assert.equal(renders, 2);
});

test('scale info API requests the connected-scale endpoint and preserves status', async () => {
    const match = apiSource.match(/export async function getScaleInfo\(\) \{[\s\S]*?\n\}/);
    assert.ok(match);
    let request;
    const getScaleInfo = new Function('fetch', 'API_BASE_URL',
        `${match[0].replace('export ', '')}\nreturn getScaleInfo;`)(async url => {
        request = url;
        return { ok: true, json: async () => ({ firmwareVersion: 'R029' }) };
    }, 'http://localhost:8080/api/v1');
    assert.deepEqual(await getScaleInfo(), { firmwareVersion: 'R029' });
    assert.equal(request, 'http://localhost:8080/api/v1/scale/info');

    const unavailable = new Function('fetch', 'API_BASE_URL',
        `${match[0].replace('export ', '')}\nreturn getScaleInfo;`)(async () => ({ ok: false, status: 404 }), 'http://localhost:8080/api/v1');
    await assert.rejects(unavailable(), error => error.status === 404);
});

function loadPopup({ settings, device, getTranslation }) {
    const title = { textContent: '' };
    const content = { innerHTML: '' };
    let shown = 0;
    let translated = 0;
    const nodes = { 'scale-device-settings-title': title, 'scale-device-settings-content': content,
        'scale-device-settings-modal': { showModal() { shown += 1; } } };
    const open = new Function('settingsCache', 'deviceStateCache', 'document', 'getTranslation', 'escapeHtml', 'translatePage',
        `const getScaleDeviceSetting = ${getScaleDeviceSetting.toString()};
const hasSkaleUsbSetting = ${hasSkaleUsbSetting.toString()};
${extractFunction('renderScalePopupToggle')}
return (${extractAssignedFunction('openScaleDeviceSettings')});`)(
        { rea: settings }, { devices: [device] }, { getElementById: id => nodes[id] }, getTranslation,
        value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;'),
        () => { translated += 1; });
    return { open, title, content, get shown() { return shown; }, get translated() { return translated; } };
}

test('Skale popup translates title and USB control and gives the checkbox an accessible name', () => {
    const translations = { Settings: 'Einstellungen', 'Skale USB Power': 'Skale-USB-Stromversorgung',
        'Declare USB power manually and hide the battery level.': 'Akkustand ausblenden.' };
    const popup = loadPopup({ settings: { skalePoweredByUsbByDevice: { A: true } },
        device: { id: 'A', name: 'Skale 2' }, getTranslation: key => translations[key] || key });
    popup.open('A');
    assert.equal(popup.title.textContent, 'Einstellungen: Skale 2');
    assert.match(popup.content.innerHTML, /aria-label="Skale-USB-Stromversorgung"/);
    assert.match(popup.content.innerHTML, /Akkustand ausblenden/);
    assert.match(popup.content.innerHTML, /checked/);
    assert.doesNotMatch(popup.content.innerHTML, /Preferred|suppress battery reads/);
    assert.equal(popup.shown, 1);
    assert.equal(popup.translated, 1);
});

test('unsupported device popups stay closed even if invoked directly', () => {
    for (const [settings, name] of [[{}, 'Skale 2'], [{ skalePoweredByUsb: true }, 'Skale 2'], [{ skalePoweredByUsbByDevice: {} }, 'Acaia']]) {
        const popup = loadPopup({ settings, device: { id: 'A', name }, getTranslation: key => key });
        popup.open('A');
        assert.equal(popup.shown, 0);
        assert.equal(popup.content.innerHTML, '');
    }
});
