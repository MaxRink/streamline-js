import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

class Element {
    constructor(parent = null) {
        this.parent = parent;
        this.listeners = new Map();
    }

    addEventListener(type, listener) {
        this.listeners.set(type, [...(this.listeners.get(type) || []), listener]);
    }

    emit(type, event) {
        for (const listener of this.listeners.get(type) || []) listener(event);
        if (!event.stopped) this.parent?.emit(type, event);
    }

    tap() {
        for (const type of ['pointerdown', 'click']) {
            this.emit(type, {
                target: this,
                clientX: 20,
                clientY: 20,
                stopped: false,
                stopPropagation() { this.stopped = true; }
            });
        }
    }
}

test('tapping the main chart zooms, tapping the zoomed chart (or Escape) leaves', () => {
    const app = readFileSync(new URL('../src/modules/app.js', import.meta.url), 'utf8');
    const start = app.indexOf('function wireExpandedChart()');
    const end = app.indexOf("// Which profile record is the header currently showing?", start);
    const mainChart = new Element();
    const zoomed = new Element();
    const documentTarget = new Element();
    documentTarget.getElementById = id => ({
        'plotly-chart': mainChart,
        'expanded-chart': zoomed
    })[id] || null;
    let open = false;
    let opens = 0;
    let closes = 0;
    const chart = {
        openExpandedChart() { opens += 1; open = true; },
        closeExpandedChart() { closes += 1; open = false; },
        isExpandedChartOpen: () => open
    };
    const wireExpandedChart = new Function(
        'chart',
        'document',
        'console',
        `${app.slice(start, end)}\nreturn wireExpandedChart;`
    )(chart, documentTarget, console);

    wireExpandedChart();
    mainChart.tap();
    assert.equal(opens, 1);
    zoomed.tap();
    assert.equal(closes, 1);
    mainChart.tap();
    documentTarget.emit('keydown', { key: 'Enter' });
    assert.equal(closes, 1);
    documentTarget.emit('keydown', { key: 'Escape' });
    assert.equal(closes, 2);
});

// ── The dial-in strip of the zoomed layout (#159-style mirror of #shot-settings) ──
// The zoomed layout hides the 480px sidebar to win the chart's width, so the values
// have to reappear above the chart or they are gone for as long as the chart is
// zoomed. Mirrored by MutationObserver because five modules write those nodes.
test('the dial-in strip mirrors the hidden sidebar, picks the live steam node, and stops cleanly', async () => {
    const nodes = new Map();
    const node = (id, textContent) => {
        const element = { id, textContent, observers: [] };
        nodes.set(id, element);
        return element;
    };
    node('grind-value', '8.5');
    node('dose-in-value', '18.0g');
    node('drink-out-value', '36g');
    node('temp-value', '92');
    node('steam-duration-value', '');   // time mode is off, so this one is blank
    node('steam-flow-value', '25s');    // ... and the flow node is the live one
    node('flush-value', '4');
    node('hot-water-vol-value', '75ml');
    node('hot-water-temp-value', '80\u00B0c');
    const strip = { id: 'zoom-dialin', children: [], replaceChildren(...kids) { this.children = kids; } };
    nodes.set('zoom-dialin', strip);

    const previousDocument = globalThis.document;
    const previousObserver = globalThis.MutationObserver;
    const previousRaf = globalThis.requestAnimationFrame;
    const previousCancel = globalThis.cancelAnimationFrame;
    let rafCallback = null;
    // i18n.js builds an off-screen measuring span at module load, so the stub needs
    // `style` and an addEventListener as well as the two calls this module makes.
    globalThis.document = {
        getElementById: id => nodes.get(id) || null,
        addEventListener() {},
        createElement: () => ({
            className: '', textContent: '', style: {}, kids: [],
            append(...kids) { this.kids.push(...kids); }
        })
    };
    globalThis.MutationObserver = class {
        constructor(callback) { this.callback = callback; this.targets = []; }
        observe(target) { this.targets.push(target); target.observers.push(this); }
        disconnect() { for (const target of this.targets) target.observers = target.observers.filter(o => o !== this); }
    };
    globalThis.requestAnimationFrame = callback => { rafCallback = callback; return 1; };
    globalThis.cancelAnimationFrame = () => { rafCallback = null; };

    try {
        const { startZoomDialIn, stopZoomDialIn } = await import('../src/modules/zoom-dialin.js');
        startZoomDialIn();

        const shown = strip.children.map(pair => pair.kids.map(span => span.textContent).join(' '));
        assert.deepEqual(shown, ['Grind 8.5', 'Dose 18.0g', 'Drink 36g', 'Brew 92', 'Steam 25s', 'Flush 4',
            'Hot Water 75ml (80\u00B0c)'],
            'every filled value appears once, the blank steam node loses to the live one, '
            + 'and hot water carries its temperature in brackets as the TCL line does');
        // A blank value is dropped rather than shown as a bare label.
        nodes.get('flush-value').textContent = '';
        nodes.get('grind-value').textContent = '9.0';
        nodes.get('grind-value').observers[0].callback();
        assert.ok(rafCallback, 'repaints are coalesced into one frame, not run per mutation');
        rafCallback();
        const afterEdit = strip.children.map(pair => pair.kids.map(span => span.textContent).join(' '));
        assert.deepEqual(afterEdit, ['Grind 9.0', 'Dose 18.0g', 'Drink 36g', 'Brew 92', 'Steam 25s',
            'Hot Water 75ml (80\u00B0c)']);

        // A blank temperature leaves the volume alone rather than printing "75ml ()".
        nodes.get('hot-water-temp-value').textContent = '';
        nodes.get('hot-water-temp-value').observers[0].callback();
        rafCallback();
        assert.equal(strip.children.at(-1).kids.map(span => span.textContent).join(' '), 'Hot Water 75ml');

        // Starting twice must not double the observers, or one edit would repaint twice.
        startZoomDialIn();
        assert.equal(nodes.get('grind-value').observers.length, 1);

        stopZoomDialIn();
        assert.deepEqual(strip.children, [], 'the strip is emptied so nothing stale flashes on the next zoom');
        assert.equal(nodes.get('grind-value').observers.length, 0, 'observers are released with the layout');
    } finally {
        globalThis.document = previousDocument;
        globalThis.MutationObserver = previousObserver;
        globalThis.requestAnimationFrame = previousRaf;
        globalThis.cancelAnimationFrame = previousCancel;
    }
});
