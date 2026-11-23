import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

import { shouldWriteStatus } from '../src/modules/machine-status-render.js';

const html = (content) => ({ type: 'html', content });
const text = (content) => ({ type: 'text', content });
const counter = (label, value, colour = 'status-ready-green') =>
    html(`<span class="text-[var(--${colour})]">${label}:</span> <span class="text-[var(--status-clickable-color)]">${value}s</span>`);

test('first render writes, including an empty status', () => {
    assert.equal(shouldWriteStatus(undefined, html('')), true);
    assert.equal(shouldWriteStatus(undefined, text('Ready')), true);
});

test('identical status content twice suppresses the second write', () => {
    assert.equal(shouldWriteStatus(counter('Steaming', 12), counter('Steaming', 12)), false);
    assert.equal(shouldWriteStatus(text('Ready'), text('Ready')), false);
});

test('a counter change repaints', () => {
    assert.equal(shouldWriteStatus(counter('Steaming', 12), counter('Steaming', 13)), true);
});

test('a substate or colour change repaints even with the same counter', () => {
    assert.equal(shouldWriteStatus(counter('Preinfusion', 12), counter('Pouring', 12)), true);
    assert.equal(shouldWriteStatus(counter('Heating', 12, 'status-red-color'), counter('Heating', 12)), true);
});

test('a translation change repaints without changing machine state', () => {
    assert.equal(shouldWriteStatus(counter('Steaming', 12), counter('Vapeur', 12)), true);
    assert.equal(shouldWriteStatus(text('Ready'), text('Prêt')), true);
});

test('a profile step name change repaints', () => {
    assert.equal(shouldWriteStatus(counter('Bloom', 12), counter('Extract', 12)), true);
});

test('a heating countdown change repaints', () => {
    const countdown = (seconds) => html(`<span class="text-[var(--status-red-color)]">Heating:</span><span class="text-[var(--heatingstatus)]"> ${seconds}s remaining</span>`);
    assert.equal(shouldWriteStatus(countdown(12), countdown(11)), true);
    assert.equal(shouldWriteStatus(countdown(11), countdown(11)), false);
});

test('adding or removing a click target repaints', () => {
    const plain = html('<span>Pouring | 12s</span>');
    const clickable = html('<span>Pouring | 12s</span><span id="skip-step-indicator"></span>');
    assert.equal(shouldWriteStatus(plain, clickable), true);
    assert.equal(shouldWriteStatus(clickable, plain), true);
});

test('switching between HTML and literal text never reuses the other representation', () => {
    assert.equal(shouldWriteStatus(html('<span>Ready</span>'), text('<span>Ready</span>')), true);
    assert.equal(shouldWriteStatus(text('<span>Ready</span>'), html('<span>Ready</span>')), true);
});

// Exercise the actual adapter without importing ui.js or loading a browser DOM.
const source = readFileSync(new URL('../src/modules/ui.js', import.meta.url), 'utf8');
function statusWriter() {
    const adapter = source.slice(source.indexOf('const lastMachineStatusContent ='), source.indexOf("document.addEventListener('streamline:languagechange'"));
    return runInNewContext(`${adapter}\nsetMachineStatusContent;`, { shouldWriteStatus });
}
function statusElement() {
    let content = '';
    const attributes = new Map([['data-i18n-key', 'Connecting']]);
    return {
        attributes,
        writes: 0,
        removeAttribute: (key) => attributes.delete(key),
        get innerHTML() { return content; },
        set innerHTML(value) { this.writes++; content = value; },
        get textContent() { return content; },
        set textContent(value) { this.writes++; content = value; }
    };
}

test('actual adapter shares HTML/text history and caches each element separately', () => {
    const write = statusWriter();
    const first = statusElement(), replacement = statusElement();
    write(first, '<span>Ready</span>');
    write(first, '<span>Ready</span>');
    assert.equal(first.writes, 1);
    write(first, 'Ready', 'text');
    write(first, 'Ready', 'text');
    write(first, '<span>Ready</span>');
    assert.equal(first.writes, 3);
    write(replacement, '<span>Ready</span>');
    assert.equal(replacement.writes, 1);
});

test('page translation cannot overwrite a dynamically rendered cached status', () => {
    const write = statusWriter();
    const element = statusElement();
    write(element, 'Ready', 'text');
    // Model translatePage's data-i18n-key selection and textContent assignment.
    if (element.attributes.has('data-i18n-key')) element.textContent = 'Connecting';
    write(element, 'Ready', 'text');
    assert.equal(element.textContent, 'Ready');
    assert.equal(element.writes, 1);
});
