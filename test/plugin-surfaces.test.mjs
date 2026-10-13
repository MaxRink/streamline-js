import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSkinAnswer, skinPlugins, MAX_SURFACES } from '../src/modules/plugin-surfaces.js';

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
        assert.deepEqual(parseSkinAnswer(raw), { surfaces: [] });
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

test('limits: one header button, one hint and one line per tile, three surfaces', () => {
    const btn = id => ({ id, kind: 'header-button', label: 'B' });
    assert.equal(ok([btn('a'), btn('b')]).length, 1);
    const hint = (id, tile) => ({ id, kind: 'tile-hint', tile, text: id });
    assert.deepEqual(ok([hint('a', 'dose'), hint('b', 'dose'), hint('c', 'grind')]).map(s => s.id), ['a', 'c']);
    assert.equal(ok([hint('a', 'dose'), { id: 'b', kind: 'tile-line', tile: 'dose', text: 'b' }]).length, 2);
    const tiles = ['dose', 'drink', 'grind', 'temperature'];
    const lines = tiles.map(tile => ({ id: tile, kind: 'tile-line', tile, text: tile }));
    assert.equal(ok(lines).length, MAX_SURFACES);
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
