import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSkinAnswer, skinPlugins, callableEndpoint, liveEndpoint, pushWants, RESERVED_ENDPOINTS, MAX_SURFACES,
    nextStepSize, resolveStepSize, formatStepSize } from '../src/modules/plugin-surfaces.js';

const ok = surfaces => parseSkinAnswer({ version: 1, surfaces }).surfaces;

test('the example answer from the proposal parses as written', () => {
    const s = ok([
        { id: 'main', kind: 'header-button', label: 'Plugin', text: 'Something chosen',
          image: 'https://example.com/photo.jpg', action: { type: 'open', view: 'main' } },
        { id: 'grind', kind: 'tile-hint', tile: 'grind', text: 'Last 6.4', title: 'The grind of the last shot',
          action: { type: 'set', field: 'grinderSetting', value: '6.4' } },
        { id: 'gear', kind: 'tile-line', tile: 'grind', text: 'EG-1 · 1200 rpm', action: { type: 'open', view: 'next' } },
    ]);
    assert.equal(s.length, 3);
    assert.deepEqual(s[0].action, { type: 'open', view: 'main', presentation: 'page' });
    assert.deepEqual(s[1].action, { type: 'set', field: 'grinderSetting', value: 6.4 });
});

test('wrong shape, wrong version or no answer give no surfaces and never throw', () => {
    for (const raw of [null, undefined, 'x', 3, [], {}, { version: 2, surfaces: [] }, { version: 1 }, { version: 1, surfaces: 'x' }]) {
        assert.deepEqual(parseSkinAnswer(raw), { surfaces: [], live: null });
    }
});

test('unknown kinds, bad ids and duplicate ids are dropped; the rest survive', () => {
    const s = ok([
        { id: 'a', kind: 'banner', text: 'x' },
        { id: 'bad id', kind: 'tile-line', tile: 'dose', text: 'x' },
        { id: 'a', kind: 'tile-line', tile: 'dose', text: 'one' },
        { id: 'a', kind: 'tile-line', tile: 'drink', text: 'two' },
    ]);
    assert.deepEqual(s.map(x => x.text), ['one']);
});

test('a non-string id (an array that stringifies to a valid id) is dropped', () => {
    const s = ok([
        { id: ['b'], kind: 'tile-line', tile: 'dose', text: 'array' },
        { id: 'b', kind: 'tile-line', tile: 'drink', text: 'string' },
        { id: ['b'], kind: 'tile-line', tile: 'grind', text: 'array duplicate' },
        { id: 7, kind: 'tile-line', tile: 'grind', text: 'number' },
    ]);
    assert.deepEqual(s.map(x => x.text), ['string']);
});

test('limits: one header button, one hint and one line per tile, eight surfaces', () => {
    const btn = id => ({ id, kind: 'header-button', label: 'B' });
    assert.equal(ok([btn('a'), btn('b')]).length, 1);
    const hint = (id, tile) => ({ id, kind: 'tile-hint', tile, text: id });
    assert.deepEqual(ok([hint('a', 'dose'), hint('b', 'dose'), hint('c', 'grind')]).map(s => s.id), ['a', 'c']);
    assert.equal(ok([hint('a', 'dose'), { id: 'b', kind: 'tile-line', tile: 'dose', text: 'b' }]).length, 2);
    const tiles = ['dose', 'drink', 'grind', 'temperature'];
    const lines = tiles.map(tile => ({ id: tile, kind: 'tile-line', tile, text: tile }));
    assert.equal(ok(lines).length, 4);
    assert.equal(MAX_SURFACES, 12);
    const modes = ['x', 'y', 'z', 'w'].map(id => ({ id, kind: 'tile-mode', tile: 'steam', label: id, value: 1, min: 0, max: 9, step: 1,
        action: { type: 'call', endpoint: 'e', field: 'f' } }));
    const many = [btn('b'), ...tiles.flatMap(t => [hint(`h${t}`, t), { id: `l${t}`, kind: 'tile-line', tile: t, text: t }]), ...modes];
    // 1 button + 4 hints + 4 lines + 3 steam modes (the fourth is over the per-tile limit) = 12
    assert.equal(ok(many).length, 12);
    assert.deepEqual(ok(many).filter(s => s.kind === 'tile-mode').map(s => s.id), ['x', 'y', 'z']);
});

const stepsize = (over = {}, kind = 'tile-hint') => ({ id: 'ss', kind, tile: 'dose', text: 'x',
    action: { type: 'stepsize', field: 'targetDoseWeight', sizes: [1, 0.5, 0.1], ...over } });

test('stepsize: valid action parses, sizes rounded to hundredths', () => {
    assert.deepEqual(ok([stepsize()])[0].action, { type: 'stepsize', field: 'targetDoseWeight', sizes: [1, 0.5, 0.1] });
    assert.deepEqual(ok([stepsize({ field: 'targetYield', sizes: ['2', 0.254, 10] }, 'tile-line')])[0].action.sizes, [2, 0.25, 10]);
});

test('stepsize: invalid actions are dropped and the surface stays inert', () => {
    const bad = [{ sizes: [1, 2, 3, 4, 5] }, { sizes: [] }, { sizes: [0] }, { sizes: [-1] }, { sizes: [10.01] },
        { sizes: [0.004] }, { sizes: ['x'] }, { sizes: 1 }, { field: 'grinderSetting' }, { field: 'brewTemperature' }];
    for (const over of bad) {
        const [s] = ok([stepsize(over)]);
        assert.ok(s, JSON.stringify(over));
        assert.equal(s.action, undefined, JSON.stringify(over));
    }
});

test('stepsize: invalid sizes with no text keep the surface inert with a placeholder', () => {
    const [s] = ok([{ id: 'ss', kind: 'tile-hint', tile: 'dose', action: { type: 'stepsize', field: 'targetDoseWeight', sizes: [] } }]);
    assert.ok(s);
    assert.equal(s.action, undefined);
    assert.equal(s.text, '±1 g');
});

test('stepValue clamps to min', async () => {
    const { stepValue } = await import('../src/modules/value-format.js');
    assert.equal(stepValue(5, 10, -1, 0), 0);
    assert.equal(stepValue(5, 0.5, -1, 0), 4.5);
    assert.equal(stepValue(5, 1, 1), 6);
});

test('stepsize: only on tile-hint and tile-line', () => {
    const action = { type: 'stepsize', field: 'targetDoseWeight', sizes: [1] };
    assert.equal(ok([{ id: 'a', kind: 'header-button', label: 'B', action }])[0].action, undefined);
    assert.equal(ok([{ id: 'a', kind: 'tile-mode', tile: 'dose', label: 'M', value: 1, min: 0, max: 5, action }]).length, 0);
});

test('stepsize helpers: next wraps, unknown current goes to the first, text format', () => {
    assert.equal(nextStepSize([1, 0.5, 0.1], 1), 0.5);
    assert.equal(nextStepSize([1, 0.5, 0.1], 0.1), 1);
    assert.equal(nextStepSize([1, 0.5, 0.1], 7), 1);
    assert.equal(nextStepSize([1, 0.5], null), 1);
    assert.equal(resolveStepSize([1, 0.5], 0.5), 0.5);
    assert.equal(resolveStepSize([1, 0.5], 3), 1);
    assert.equal(formatStepSize(0.5), '±0.5 g');
    assert.equal(formatStepSize(1), '±1 g');
});

test('text is capped, stripped of control characters, and never needed as HTML', () => {
    const [s] = ok([{ id: 'a', kind: 'tile-line', tile: 'dose', text: `<b>hi</b>\n${'x'.repeat(200)}` }]);
    assert.ok(s.text.length <= 40);
    assert.ok(!/[\n\r]/.test(s.text));
    assert.ok(s.text.startsWith('<b>hi</b>')); // kept verbatim: the renderer uses textContent
});

test('a surface with no required text, label or a known tile is dropped', () => {
    assert.equal(ok([{ id: 'a', kind: 'header-button', label: '  ' }]).length, 0);
    assert.equal(ok([{ id: 'a', kind: 'tile-hint', tile: 'dose', text: '' }]).length, 0);
    assert.equal(ok([{ id: 'a', kind: 'tile-line', tile: 'steam', text: 'x' }]).length, 0);
});

test('images must be https without credentials, otherwise only the image is dropped', () => {
    const img = image => ok([{ id: 'a', kind: 'header-button', label: 'B', image }])[0];
    assert.equal(img('https://example.com/a.png').image, 'https://example.com/a.png');
    for (const bad of ['http://example.com/a.png', 'javascript:alert(1)', 'https://u:p@example.com/a.png', 'data:image/png;base64,AAAA', 42]) {
        const s = img(bad);
        assert.equal(s.label, 'B');
        assert.equal(s.image, undefined);
    }
});

test('open: presentation is a hint, unknown values fall back to page', () => {
    const open = a => ok([{ id: 'a', kind: 'header-button', label: 'B', action: { type: 'open', ...a } }])[0].action;
    assert.equal(open({ view: 'main' }).presentation, 'page');
    assert.equal(open({ view: 'main', presentation: 'overlay' }).presentation, 'overlay');
    assert.equal(open({ view: 'main', presentation: 'fullscreen' }).presentation, 'page');
    assert.equal(open({ view: '../../etc' }).view, '');
});

test('step moves a steppable tile field by a bounded non-zero amount', () => {
    const step = (field, by, kind = 'tile-hint') => ok([{ id: 'a', kind, tile: 'dose', text: 'x', action: { type: 'step', field, by } }])[0]?.action;
    assert.deepEqual(step('targetDoseWeight', '-0.5'), { type: 'step', field: 'targetDoseWeight', by: -0.5 });
    assert.deepEqual(step('grinderSetting', 1, 'tile-line'), { type: 'step', field: 'grinderSetting', by: 1 });
    for (const bad of [0, 101, 'x', null]) assert.ok(!step('targetYield', bad));
    assert.ok(!step('brewTemperature', 1));
    assert.ok(!step('targetDoseWeight', 1, 'header-button'));
});

test('set: only dose, yield, grind and brew temperature, as numbers clamped to the tile maximums', () => {
    const set = (field, value) => ok([{ id: 'a', kind: 'tile-hint', tile: 'dose', text: 'x', action: { type: 'set', field, value } }])[0].action;
    assert.deepEqual(set('targetDoseWeight', 18.5), { type: 'set', field: 'targetDoseWeight', value: 18.5 });
    assert.equal(set('targetYield', '36').value, 36);
    assert.equal(set('targetYield', 9999).value, 2000);
    assert.equal(set('targetDoseWeight', 500).value, 30);
    assert.equal(set('grinderSetting', 99999).value, 9999);
    assert.equal(set('targetDoseWeight', 0).value, 1);
    assert.equal(set('grinderSetting', 6.456).value, 6.46);
    assert.deepEqual(set('brewTemperature', 93), { type: 'set', field: 'brewTemperature', value: 93 });
    assert.equal(set('brewTemperature', 20).value, 70);
    assert.equal(set('brewTemperature', 500).value, 105);
    for (const [field, value] of [['brewTemperature', 'hot'], ['profile', 'x'], ['constructor', 1], ['__proto__', 1], ['toString', 1], ['machineState', 'sleeping'], ['targetYield', NaN],
        ['targetYield', Infinity], ['grinderSetting', ''], ['grinderSetting', 'C40'], ['grinderSetting', { a: 1 }]]) {
        assert.equal(set(field, value), undefined);
    }
});

test('an invalid action leaves the surface, inert; header buttons cannot set', () => {
    const [s] = ok([{ id: 'a', kind: 'tile-line', tile: 'dose', text: 'x', action: { type: 'shell', cmd: 'rm -rf' } }]);
    assert.equal(s.text, 'x');
    assert.equal(s.action, undefined);
    const [h] = ok([{ id: 'b', kind: 'header-button', label: 'B', action: { type: 'set', field: 'targetYield', value: 36 } }]);
    assert.equal(h.action, undefined);
});

test('only loaded plugins with an http skin endpoint are asked', () => {
    const skin = { id: 'skin', type: 'http' };
    const plugins = [
        { id: 'a', loaded: true, api: [skin] },
        { id: 'b', loaded: false, api: [skin] },
        { id: 'c', loaded: true, api: [{ id: 'ui', type: 'http' }] },
        { id: 'd', loaded: true, api: [{ id: 'skin', type: 'websocket' }] },
        { id: 'e', loaded: true },
        null,
    ];
    assert.deepEqual(skinPlugins(plugins).map(p => p.id), ['a']);
    assert.deepEqual(skinPlugins(null), []);
});

const mode = over => ({ id: 'pct', kind: 'tile-mode', tile: 'temperature', label: '%', unit: '%', value: 5,
    min: -20, max: 20, step: 1, decimals: 0, presets: [-5, -2, 2, 5],
    action: { type: 'call', endpoint: 'apply', field: 'percent' }, ...over });

test('tile-mode: the documented example parses as written', () => {
    assert.deepEqual(ok([mode()])[0], {
        id: 'pct', kind: 'tile-mode', tile: 'temperature', label: '%', unit: '%', value: 5,
        min: -20, max: 20, step: 1, decimals: 0, presets: [-5, -2, 2, 5],
        action: { type: 'call', endpoint: 'apply', field: 'percent' },
    });
});

test('tile-mode: any left-column tile, defaults, numeric strings, and numbers clamped to min..max', () => {
    for (const tile of ['dose', 'drink', 'grind', 'temperature', 'steam', 'flush']) assert.equal(ok([mode({ tile })]).length, 1);
    assert.equal(ok([mode({ tile: 'hotwater' })]).length, 0);
    const m = ok([mode({ step: undefined, decimals: undefined, unit: undefined, value: '99', presets: [-50, '3', 'x', null, 1, 2, 4] })])[0];
    assert.equal(m.step, 1);
    assert.equal(m.decimals, 0);
    assert.equal('unit' in m, false);
    assert.equal(m.value, 20);
    assert.deepEqual(m.presets, [-20, 3, 1, 2]); // junk skipped, four at most
});

test('tile-mode: a mode that cannot be stepped, shown or called is dropped', () => {
    for (const bad of [
        { label: '' }, { label: 5 }, { value: 'x' }, { value: undefined },
        { min: 5, max: 5 }, { min: 10, max: -10 }, { min: -10000 }, { max: 10000 }, { min: 'a' },
        { step: 0 }, { step: -1 }, { step: 41 }, { decimals: 3 }, { decimals: 1.5 },
        { action: undefined }, { action: { type: 'open', view: 'main' } },
        { action: { type: 'set', field: 'targetYield', value: 36 } },
        { action: { type: 'call', endpoint: 'skin', field: 'percent' } },
        { action: { type: 'call', endpoint: 'bad id', field: 'percent' } },
        { action: { type: 'call', endpoint: 'apply', field: '1x' } },
        { action: { type: 'call', endpoint: 'apply', field: 'a b' } },
    ]) assert.equal(ok([mode(bad)]).length, 0, JSON.stringify(bad));
});

test('tile-mode: label and unit are capped, up to three modes per tile', () => {
    const m = ok([mode({ label: 'abcdefghij', unit: 'abcdef' })])[0];
    assert.equal(m.label, 'abcdef');
    assert.equal(m.unit, 'abc');
    const many = ok([mode(), mode({ id: 'other' }), mode({ id: 'third' }), mode({ id: 'fourth' }), mode({ id: 'dose-m', tile: 'dose' })]);
    assert.deepEqual(many.map(x => x.id), ['pct', 'other', 'third', 'dose-m']);
});

test('tile-mode: a second value is a bounded number on steam and drink; applyOnSelect needs a real true', () => {
    const second = { field: 'flow', value: 1.26, min: 0.4, max: 2, decimals: 1, unit: 'ml/s' };
    const m = ok([mode({ tile: 'steam', second, applyOnSelect: true })])[0];
    assert.deepEqual(m.second, { field: 'flow', unit: 'ml/s', decimals: 1, min: 0.4, max: 2, value: 1.3 });
    assert.equal(m.applyOnSelect, true);
    // other tiles have no second line; a bad second leaves the mode without one
    assert.equal('second' in ok([mode({ tile: 'dose', second })])[0], false);
    for (const bad of [{ ...second, field: 'percent' }, { ...second, field: '9x' }, { ...second, min: 3 },
        { ...second, decimals: 5 }, { ...second, value: 'x' }, 'text', null]) {
        assert.equal('second' in ok([mode({ tile: 'steam', second: bad })])[0], false);
    }
    assert.equal(ok([mode({ tile: 'steam', second: { ...second, unit: 'abcdefghij' } })])[0].second.unit, 'abcdef');
    assert.equal('applyOnSelect' in ok([mode({ applyOnSelect: 'yes' })])[0], false);
});

test('call is only valid on a tile-mode; the mode may share a tile with a hint and a line', () => {
    const call = { type: 'call', endpoint: 'apply', field: 'percent' };
    const s = ok([
        { id: 'h', kind: 'tile-hint', tile: 'temperature', text: 'x', action: call },
        { id: 'b', kind: 'header-button', label: 'x', action: call },
        mode(),
    ]);
    assert.deepEqual(s.map(x => [x.id, 'action' in x]), [['h', false], ['b', false], ['pct', true]]);
    const same = ok([
        { id: 'h', kind: 'tile-hint', tile: 'temperature', text: 'x' },
        { id: 'l', kind: 'tile-line', tile: 'temperature', text: 'x' },
        mode(),
    ]);
    assert.equal(same.length, 3);
});

test('callableEndpoint: only an http endpoint the plugin declares, never skin', () => {
    const plugin = { api: [{ id: 'skin', type: 'http' }, { id: 'apply', type: 'http' }, { id: 'stream', type: 'websocket' }] };
    assert.equal(callableEndpoint(plugin, 'apply'), true);
    assert.equal(callableEndpoint(plugin, 'skin'), false);
    assert.equal(callableEndpoint(plugin, 'stream'), false);
    assert.equal(callableEndpoint(plugin, 'other'), false);
    assert.equal(callableEndpoint({}, 'apply'), false);
    assert.equal(callableEndpoint(plugin, 5), false);
});

test('tile-mode: step finer than decimals is dropped; a valid step is rounded to decimals', () => {
    for (const bad of [{ step: 0.4, decimals: 0 }, { step: 0.004, decimals: 2 }, { step: 0.04, decimals: 1 }, { step: 0.2, decimals: 0 }]) {
        assert.equal(ok([mode(bad)]).length, 0, JSON.stringify(bad));
    }
    assert.equal(ok([mode({ step: 0.01, decimals: 2 })])[0].step, 0.01);
    assert.equal(ok([mode({ step: 0.5, decimals: 1 })])[0].step, 0.5);
    assert.equal(ok([mode({ step: 1.4, decimals: 0 })])[0].step, 1);
    assert.equal(ok([mode({ step: 0.5, decimals: 0 })])[0].step, 1); // rounds up to the finest step shown
    assert.equal(ok([mode({ step: 41, decimals: 0 })]).length, 0);
});

test('tile-mode: min and max must fit decimals', () => {
    assert.equal(ok([mode({ min: 0.4, max: 10, decimals: 0 })]).length, 0);
    assert.equal(ok([mode({ min: 0, max: 9.5, decimals: 0 })]).length, 0);
    assert.equal(ok([mode({ min: 0.5, max: 9.5, decimals: 1, step: 0.5 })]).length, 1);
    assert.equal(ok([mode({ min: 0.125, max: 9, decimals: 2 })]).length, 0);
});

test('tile-mode: value and presets are clamped and rounded to decimals', () => {
    const m = ok([mode({ min: 0, max: 10, decimals: 1, step: 0.1, value: 3.14159, presets: [0.26, 99, -3, '1.04'] })])[0];
    assert.equal(m.value, 3.1);
    assert.deepEqual(m.presets, [0.3, 10, 0, 1]);
    assert.equal(ok([mode({ value: 4.6 })])[0].value, 5);
    assert.deepEqual(ok([mode({ presets: [1.4, 2.5] })])[0].presets, [1, 3]);
});

test('reserved endpoint ids are neither parsed nor callable', () => {
    for (const id of ['skin', 'settings', 'enable', 'disable', 'source', 'update', 'install']) {
        assert.ok(RESERVED_ENDPOINTS.includes(id), id);
        const action = { type: 'call', endpoint: id, field: 'percent' };
        assert.equal(ok([mode({ action })]).length, 0, id);
        assert.equal(callableEndpoint({ api: [{ id, type: 'http' }] }, id), false, id);
    }
});

test('tile-mode: menu items are label and number, capped, clamped; presetsEditable only when false', () => {
    const m = ok([mode({ menu: [
        { label: 'Reset to 0%', value: 0 }, { label: 'Hot', value: 99 }, { label: '', value: 1 },
        { label: 'x', value: 'n' }, null, 'str', { label: 'Four', value: '3' }, { label: 'Five', value: 4 }, { label: 'Six', value: 5 },
    ] })])[0];
    assert.deepEqual(m.menu, [{ label: 'Reset to 0%', value: 0 }, { label: 'Hot', value: 20 }, { label: 'Four', value: 3 }, { label: 'Five', value: 4 }]);
    assert.equal('presetsEditable' in m, false);
    assert.equal(ok([mode({ presetsEditable: false })])[0].presetsEditable, false);
    assert.equal('presetsEditable' in ok([mode({ presetsEditable: true })])[0], false);
    assert.equal('menu' in ok([mode({ menu: 'x' })])[0], false);
});

const hintCall = over => ({ id: 'lock', kind: 'tile-hint', tile: 'drink', text: 'Ratio', active: true,
    action: { type: 'call', endpoint: 'ratio', field: 'lock', value: 1 }, ...over });

test('call on a hint or line carries one fixed number; active marks it on', () => {
    const [h] = ok([hintCall()]);
    assert.deepEqual(h.action, { type: 'call', endpoint: 'ratio', field: 'lock', value: 1 });
    assert.equal(h.active, true);
    const [l] = ok([{ id: 'l', kind: 'tile-line', tile: 'dose', text: 'x',
        action: { type: 'call', endpoint: 'ratio', field: 'lock', value: '0.456' } }]);
    assert.equal(l.action.value, 0.46);
    assert.equal('active' in l, false);
    assert.equal('active' in ok([hintCall({ active: 'yes' })])[0], false);
    assert.equal('active' in ok([hintCall({ active: false })])[0], false);
});

test('a hint or line call without a usable value, or to a reserved endpoint, is inert; header buttons cannot call', () => {
    for (const action of [
        { type: 'call', endpoint: 'ratio', field: 'lock' },
        { type: 'call', endpoint: 'ratio', field: 'lock', value: 'x' },
        { type: 'call', endpoint: 'ratio', field: 'lock', value: 1e9 },
        { type: 'call', endpoint: 'ratio', field: 'lock', value: Infinity },
        { type: 'call', endpoint: 'settings', field: 'lock', value: 1 },
        { type: 'call', endpoint: 'ratio', field: '1x', value: 1 },
    ]) {
        const [h] = ok([hintCall({ action })]);
        assert.equal(h.text, 'Ratio', JSON.stringify(action));       // the surface still shows
        assert.equal('action' in h, false, JSON.stringify(action));  // inert
    }
    const [b] = ok([{ id: 'b', kind: 'header-button', label: 'x',
        action: { type: 'call', endpoint: 'ratio', field: 'lock', value: 1 } }]);
    assert.equal('action' in b, false);
});

test('a tile-mode call still takes no value', () => {
    const m = ok([mode({ action: { type: 'call', endpoint: 'apply', field: 'percent', value: 5 } })])[0];
    assert.deepEqual(m.action, { type: 'call', endpoint: 'apply', field: 'percent' });
});

test('screensaver-button: label and an open action only; anything else is dropped', () => {
    const btn = extra => ok([{ id: 's', kind: 'screensaver-button', label: 'Dial in', ...extra }]);
    const open = { type: 'open', view: 'main', presentation: 'overlay' };
    assert.deepEqual(btn({ action: open })[0], { id: 's', kind: 'screensaver-button', label: 'Dial in', action: open });
    assert.equal(btn({}).length, 0); // no action: dead button
    assert.equal(btn({ action: { type: 'set', field: 'targetYield', value: 36 } }).length, 0);
    assert.equal(btn({ action: { type: 'call', endpoint: 'x', field: 'y', value: 1 } }).length, 0);
    assert.equal(ok([{ id: 's', kind: 'screensaver-button', label: ' ', action: open }]).length, 0);
    assert.equal(btn({ label: 'x'.repeat(60), action: open })[0].label.length, 24);
});

test('screensaver-button: one per answer, independent of the header button', () => {
    const open = { type: 'open', view: 'main' };
    const s = id => ({ id, kind: 'screensaver-button', label: 'S', action: open });
    assert.deepEqual(ok([s('a'), s('b')]).map(x => x.id), ['a']);
    const h = { id: 'h', kind: 'header-button', label: 'H' };
    assert.equal(ok([h, s('a')]).length, 2);
});

test('live names a websocket endpoint; it is only used when the plugin declares it', () => {
    const answer = (live) => parseSkinAnswer({ version: 1, surfaces: [], live });
    assert.deepEqual(answer({ endpoint: 'changed' }).live, { endpoint: 'changed' });
    for (const bad of [null, undefined, 'changed', {}, { endpoint: 5 }, { endpoint: 'bad id' }, { endpoint: 'skin' }, { endpoint: 'settings' }]) {
        assert.equal(answer(bad).live, null, JSON.stringify(bad));
    }
    const plugin = { api: [{ id: 'changed', type: 'websocket' }, { id: 'apply', type: 'http' }] };
    assert.equal(liveEndpoint(plugin, { endpoint: 'changed' }), 'changed');
    assert.equal(liveEndpoint(plugin, { endpoint: 'apply' }), null);      // http, not a socket
    assert.equal(liveEndpoint(plugin, { endpoint: 'other' }), null);
    assert.equal(liveEndpoint({}, { endpoint: 'changed' }), null);
    assert.equal(liveEndpoint(plugin, null), null);
});

test('pushWants: only {"what":"skin"} skips the workflow re-read', () => {
    const both = { skin: true, workflow: true };
    assert.deepEqual(pushWants('{"what":"skin"}'), { skin: true, workflow: false });
    assert.deepEqual(pushWants({ what: 'skin' }), { skin: true, workflow: false });
    assert.deepEqual(pushWants('{"what":"workflow"}'), both);
    assert.deepEqual(pushWants('{}'), both);
    assert.deepEqual(pushWants('not json'), both);
    assert.deepEqual(pushWants(undefined), both);
    assert.deepEqual(pushWants('null'), both);
    assert.deepEqual(pushWants('"skin"'), both);
});

test('an empty surfaces list with live is a valid answer', () => {
    assert.deepEqual(parseSkinAnswer({ version: 1, surfaces: [], live: { endpoint: 'changed' } }),
        { surfaces: [], live: { endpoint: 'changed' } });
});
