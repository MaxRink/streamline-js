import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildBeanScaleCapture, selectableBeanScales } from '../src/modules/bean-scale.js';
import { selectableBeans, selectableBatches, currentBeanContext } from '../src/modules/bean-selection.js';

class Element extends EventTarget {
    constructor() { super(); this.children = []; this.value = ''; this.disabled = false; this.attributes = {}; }
    append(child) { this.children.push(child); if (!this.value && !child.disabled) this.value = child.value; }
    appendChild(child) { this.append(child); }
    replaceChildren(...children) { this.children = []; this.value = ''; children.forEach(child => this.append(child)); }
    setAttribute(name, value) { this.attributes[name] = value; }
    remove() { this.removed = true; }
    showModal() { assert.notEqual(this.removed, true, 'must not reopen a removed dialog'); this.open = true; }
    close() { this.open = false; this.dispatchEvent(new Event('close')); }
    querySelector(selector) { return this.nodes[selector]; }
    set innerHTML(_) {
        const form = new Element(); form.elements = { device: new Element(), bean: new Element(), batch: new Element() };
        this.nodes = { form, output: new Element(), '[data-capture]': new Element(), '[data-status]': new Element(), '[data-save]': new Element() };
        this.nodes['[data-capture]'].disabled = true;
    }
}

function harness(file, overrides = {}) {
    const dialogs = [];
    const listeners = new Map();
    const window = {
        addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener); },
        removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    };
    const document = { body: new Element(), createElement(type) { const node = new Element(); if (type === 'dialog') dialogs.push(node); return node; } };
    let now = Date.parse('2026-10-12T10:00:00Z');
    class Clock extends Date { constructor(value) { super(value ?? now); } static now() { return now; } }
    const streams = []; let closes = 0;
    const dependencies = {
        window, document, Date: Clock, Option: class extends Element { constructor(text, value) { super(); this.textContent = text; this.value = value; } },
        getTranslation: key => key, selectableBeanScales, buildBeanScaleCapture, selectableBeans, selectableBatches, currentBeanContext,
        getScaleDevices: async () => [{ id: 'aux/1', name: 'Bean scale', type: 'scale', connectionRole: 'auxiliary', state: 'connected' }],
        connectAddressedScaleWebSocket: (id, sample, _, disconnected) => streams.push({ id, sample, disconnected }),
        closeAddressedScaleWebSocket: () => closes++, getBeans: async () => [], getBeanBatches: async () => [], updateWorkflow: async () => {}, ...overrides,
    };
    const source = readFileSync(new URL(`../src/modules/${file}.js`, import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace('export async function', 'async function');
    const name = file === 'bean-scale-modal' ? 'openBeanScaleCaptureModal' : 'openBeanSelectionModal';
    const open = new Function(...Object.keys(dependencies), `${source}\nreturn ${name};`)(...Object.values(dependencies));
    return { open, dialogs, streams, listeners, get closes() { return closes; }, advance(ms) { now += ms; }, pagehide() { for (const fn of [...(listeners.get('pagehide') || [])]) fn(); } };
}

test('single auxiliary scale starts immediately and rejects stale confirmation', async () => {
    const h = harness('bean-scale-modal'); const captures = [];
    const dialog = await h.open({ onCapture: value => captures.push(value) });
    assert.equal(h.streams.length, 1);
    assert.equal(h.streams[0].id, 'aux/1');
    assert.equal(dialog.attributes['aria-label'], 'Capture bean weight');
    h.streams[0].sample({ weight: 18.2 });
    const button = dialog.querySelector('[data-capture]'); assert.equal(button.disabled, false);
    h.advance(10001); button.dispatchEvent(new Event('click'));
    assert.equal(captures.length, 0); assert.equal(button.disabled, true);
    h.streams[0].sample({ weight: 18.4 }); button.dispatchEvent(new Event('click'));
    assert.equal(captures.length, 1); assert.equal(captures[0].weight, 18.4);
});

test('cancel/reopen removes pagehide callbacks and rejects old socket samples', async () => {
    const h = harness('bean-scale-modal'); const first = await h.open();
    const old = h.streams[0]; first.close();
    assert.equal(h.listeners.get('pagehide').size, 0);
    const second = await h.open(); assert.equal(h.streams.length, 2);
    old.sample({ weight: 25 }); assert.equal(second.querySelector('[data-capture]').disabled, true);
    assert.equal(h.listeners.get('pagehide').size, 1);
    h.pagehide(); assert.equal(h.listeners.get('pagehide').size, 0); assert.equal(second.removed, true);
});

test('catalog rejection after pagehide cannot reopen the coffee dialog', async () => {
    let reject;
    const h = harness('bean-selection-modal', { getBeans: () => new Promise((_, fail) => { reject = fail; }) });
    const opening = h.open(); h.pagehide(); reject(new Error('network unavailable'));
    await opening;
    assert.equal(h.dialogs[0].removed, true); assert.notEqual(h.dialogs[0].open, true);
    assert.equal(h.listeners.get('pagehide').size, 0);
});

test('pending scale inventory cannot create a stream or reopen after pagehide', async () => {
    let resolve;
    const h = harness('bean-scale-modal', { getScaleDevices: () => new Promise(done => { resolve = done; }) });
    const opening = h.open(); h.pagehide();
    resolve([{ id: 'aux/1', type: 'scale', connectionRole: 'auxiliary', state: 'connected' }]);
    await opening;
    assert.equal(h.streams.length, 0); assert.equal(h.dialogs[0].removed, true);
    assert.notEqual(h.dialogs[0].open, true);
});
