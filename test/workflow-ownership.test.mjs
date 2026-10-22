// The workflow-ownership contract (#165).
//
// The live workflow is one deep-merged JSON document with no revision. Writers
// are sequential and each believes it is authorised, so a revision check would
// pass every one of the writes that caused #143/#144/#147-#149/#153/#155-#158.
// The contract is therefore about ownership, not concurrency: each writer says
// what it owns, and sending anything else is an error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
    WORKFLOW_WRITERS, workflowPatchKeys, fieldIsDeclared,
    undeclaredFields, assertDeclaredFields,
} from '../src/modules/workflow-fields.js';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

function sourceFiles(dir = SRC, out = []) {
    for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) sourceFiles(path, out);
        else if (entry.endsWith('.js')) out.push(path);
    }
    return out;
}

// Pull out the argument list of every updateWorkflow(...) call, balancing
// parens so a nested call or object literal does not truncate it.
function updateWorkflowCalls(source) {
    const calls = [];
    const re = /(?<![\w.])updateWorkflow\(/g;
    let m;
    while ((m = re.exec(source))) {
        let depth = 1, i = re.lastIndex;
        for (; i < source.length && depth; i++) {
            const c = source[i];
            if (c === '(') depth++;
            else if (c === ')') depth--;
        }
        calls.push(source.slice(re.lastIndex, i - 1));
    }
    return calls;
}

// Split on top-level commas only.
function topLevelArgs(args) {
    const parts = [];
    let depth = 0, start = 0;
    for (let i = 0; i < args.length; i++) {
        const c = args[i];
        if ('([{'.includes(c)) depth++;
        else if (')]}'.includes(c)) depth--;
        else if (c === ',' && depth === 0) { parts.push(args.slice(start, i)); start = i + 1; }
    }
    parts.push(args.slice(start));
    return parts.map(p => p.trim()).filter(Boolean);
}

test('every workflow write names a writer that is in the registry', () => {
    const offenders = [];
    for (const file of sourceFiles()) {
        const source = readFileSync(file, 'utf8');
        // api.js declares the function; its own body is not a call site.
        const body = source.replace(/export async function updateWorkflow\([\s\S]*?\n\}/, '');
        for (const args of updateWorkflowCalls(body)) {
            const parts = topLevelArgs(args);
            const writer = parts[1];
            const quoted = writer && /^'[^']+'$/.test(writer) && writer.slice(1, -1);
            if (!quoted || !(quoted in WORKFLOW_WRITERS)) {
                offenders.push(`${file.replace(SRC, 'src')}: updateWorkflow(${args.slice(0, 60)}...) -> ${writer ?? 'no writer'}`);
            }
        }
    }
    assert.deepEqual(offenders, [], `every call site must declare a known writer:\n${offenders.join('\n')}`);
});

// Adding a key here is the visible diff the contract exists to produce: it means
// a writer took ownership of something it did not own, which is a decision.
const SNAPSHOT = {
    'api.autoSteam': 'steamSettings.duration steamSettings.flow steamSettings.stopAtTemperature steamSettings.targetTemperature',
    'api.hotWater': 'hotWaterData.duration hotWaterData.flow hotWaterData.targetTemperature hotWaterData.volume',
    'api.sendProfile': 'profile',
    'api.steamDuration': 'steamSettings.duration',
    'api.steamFlow': 'steamSettings.flow',
    'api.steamHeater': 'steamSettings',
    'api.steamStopAt': 'steamSettings.stopAtTemperature',
    'api.steamTemp': 'steamSettings.targetTemperature',
    'beans.select': 'context.beanBatchId context.coffeeName context.coffeeRoaster',
    'dye.applyFavourite': 'context.baristaName context.basket context.beanBatchId context.coffeeName context.coffeeRoaster context.drinkerName context.extras.dye context.extras.rpm context.grinderSetting context.targetDoseWeight context.targetYield profile',
    'dye.applyRecipe': 'context.baristaName context.basket context.beanBatchId context.coffeeName context.coffeeRoaster context.drinkerName context.extras.dye context.extras.rpm context.grinderSetting context.targetDoseWeight context.targetYield hotWaterData.duration hotWaterData.flow hotWaterData.targetTemperature hotWaterData.volume profile rinseData steamSettings.duration steamSettings.flow steamSettings.targetTemperature',
    'dye.clearOnDisable': 'context.baristaName context.basket context.beanBatchId context.coffeeName context.coffeeRoaster context.drinkerName context.extras.dye context.extras.rpm',
    'profile.resetDefaults': 'context.grinderSetting context.targetDoseWeight context.targetYield profile',
    'profile.send': 'context.grinderSetting context.targetDoseWeight context.targetYield profile',
    'profile.wake': 'context.grinderSetting context.targetDoseWeight context.targetYield',
    'settings.hotWater': 'hotWaterData.duration hotWaterData.flow hotWaterData.targetTemperature hotWaterData.volume',
    'settings.rinse': 'rinseData',
    'settings.steam': 'steamSettings.duration steamSettings.flow steamSettings.stopAtTemperature steamSettings.targetTemperature',
    'shot.clearNote': 'context.extras.note',
    'tiles.brewTemp': 'profile.steps',
    'tiles.doseYield': 'context.targetDoseWeight context.targetYield profile.target_weight',
    'tiles.flush': 'rinseData.duration',
    'tiles.grind': 'context.grinderSetting',
    'tiles.hotWater': 'hotWaterData.duration hotWaterData.flow hotWaterData.targetTemperature hotWaterData.volume',
    'tiles.steam': 'steamSettings.duration steamSettings.flow steamSettings.targetTemperature',
};

test('the declared field set of every writer is snapshotted', () => {
    const actual = Object.fromEntries(
        Object.entries(WORKFLOW_WRITERS).map(([writer, fields]) => [writer, [...fields].sort().join(' ')]));
    assert.deepEqual(actual, SNAPSHOT);
});

test('a patch flattens to the field paths it writes', () => {
    assert.deepEqual(workflowPatchKeys({ context: { targetYield: 36 } }), ['context.targetYield']);
    assert.deepEqual(workflowPatchKeys({ context: { extras: { dye: { recipeId: 'r1' } } } }),
        ['context.extras.dye.recipeId']);
    // profile is walked one level: a writer that owns the stop weight must not
    // get to send a whole profile document under the same declaration (#155).
    assert.deepEqual(workflowPatchKeys({ profile: { title: 'x', steps: [1, 2] } }), ['profile.title', 'profile.steps']);
    assert.deepEqual(workflowPatchKeys({ profile: { target_weight: 36 } }), ['profile.target_weight']);
    // null is a write (it clears), not an absence.
    assert.deepEqual(workflowPatchKeys({ context: { grinderSetting: null } }), ['context.grinderSetting']);
    // An empty object still declares intent to touch that block.
    assert.deepEqual(workflowPatchKeys({ steamSettings: {} }), ['steamSettings']);
    assert.deepEqual(workflowPatchKeys({}), []);
});

test('declaring a group owns everything under it, a leaf owns only itself', () => {
    assert.equal(fieldIsDeclared('context.targetYield', ['context']), true);
    assert.equal(fieldIsDeclared('context.targetYield', ['context.targetYield']), true);
    assert.equal(fieldIsDeclared('context.targetYield', ['context.targetDoseWeight']), false);
    // A prefix that is not a path boundary must not match.
    assert.equal(fieldIsDeclared('contextual', ['context']), false);
    assert.equal(fieldIsDeclared('context', ['context.targetYield']), false);
});

test('an undeclared field is named, and the writer must be known', () => {
    assert.deepEqual(
        undeclaredFields({ context: { targetYield: 36, coffeeName: 'x' } }, ['context.targetYield']),
        ['context.coffeeName']);
    assert.deepEqual(undeclaredFields({ context: { targetYield: 36 } }, ['context.targetYield']), []);

    assert.throws(() => assertDeclaredFields('nope', {}), /unknown writer 'nope'/);
    assert.throws(
        () => assertDeclaredFields('tiles.grind', { context: { grinderSetting: 5, targetYield: 36 } }),
        /sent undeclared field\(s\) context\.targetYield/);
    assert.equal(assertDeclaredFields('tiles.grind', { context: { grinderSetting: 5 } }), true);
});

test('the whole-document write the contract exists to stop is rejected', () => {
    // This is what dyeStrip used to do: GET the workflow, mutate it, PUT it all
    // back -- carrying every field it did not own over a newer value.
    const live = {
        profile: { title: 'Londinium' },
        context: { targetYield: 36, coffeeName: 'Ethiopia', baristaName: 'Sam' },
        steamSettings: { duration: 30, flow: 1.2 },
        hotWaterData: { volume: 200 },
        rinseData: { duration: 5 },
    };
    assert.throws(() => assertDeclaredFields('tiles.grind', live), /sent undeclared field/);
    assert.throws(() => assertDeclaredFields('profile.send', live), /steamSettings\.duration/);

    // The #155 shape: the dose tile may move the stop weight, but sending the
    // profile it read -- brew temperature and all -- is the bug.
    assert.equal(assertDeclaredFields('tiles.doseYield', { profile: { target_weight: 36 } }), true);
    assert.throws(
        () => assertDeclaredFields('tiles.doseYield', { profile: { target_weight: 36, steps: [{ temperature: 93 }] } }),
        /profile\.steps/);
});

test('the docs precedence table names the same fields the code declares', () => {
    // Acceptance criterion 4: the table in docs/ has to match the registry, or
    // it becomes the usual stale prose that says the opposite of the code.
    const doc = readFileSync(new URL('../docs/AI_WORKFLOW_NOTES.md', import.meta.url), 'utf8');
    const declared = new Set(Object.values(WORKFLOW_WRITERS).flat());

    // Every contested field the table names must be a field some writer owns.
    const tabled = [...doc.matchAll(/`(context\.[a-zA-Z.]+|steamSettings|hotWaterData|rinseData|profile)`/g)]
        .map(m => m[1]);
    assert.ok(tabled.length > 5, 'the table should name the fields it governs');
    for (const field of new Set(tabled)) {
        assert.ok([...declared].some(d => d === field || d.startsWith(`${field}.`) || field.startsWith(`${d}.`)),
            `docs name ${field}, which no writer declares`);
    }

    // Every writer prefix must be documented, or a new surface slips in unnamed.
    for (const writer of Object.keys(WORKFLOW_WRITERS)) {
        const prefix = writer.split('.')[0];
        assert.ok(doc.includes(`\`${prefix}.*\``), `docs do not describe the '${prefix}.*' writers`);
    }
});
