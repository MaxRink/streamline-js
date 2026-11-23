#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT_VERSION = 1;
const FILES = { css: 'plugin-ui.css', js: 'plugin-ui.js' };
const BLOCK = /\/\* plugin-ui:begin \*\/\n?([\s\S]*?)\n?\/\* plugin-ui:end \*\//;
const here = dirname(fileURLToPath(import.meta.url));

const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');

async function readKit(source = here) {
    const read = async name => source.startsWith('https://')
        ? (await fetch(`${source.replace(/\/$/, '')}/${name}`, { signal: AbortSignal.timeout(15000) })).text()
        : readFile(join(source, name), 'utf8');
    const kit = { css: await read(FILES.css), js: await read(FILES.js) };
    if (/<\/style/i.test(kit.css) || /<\/script/i.test(kit.js)) throw new Error('kit text must not close its <style> or <script> element');
    return kit;
}

const hashes = kit => ({ css: sha256(kit.css), js: sha256(kit.js) });

function block(kit) {
    const value = { version: KIT_VERSION, sha256: hashes(kit), css: kit.css, js: kit.js };
    return `/* plugin-ui:begin */\nconst PLUGIN_UI = ${JSON.stringify(value)};\n/* plugin-ui:end */`;
}

function markedBlock(text, file) {
    const match = BLOCK.exec(text);
    if (!match) throw new Error(`${file}: no /* plugin-ui:begin */ ... /* plugin-ui:end */ block`);
    return match[1].trim();
}

function vendored(text, file) {
    const json = markedBlock(text, file).replace(/^const PLUGIN_UI = /, '').replace(/;$/, '');
    try {
        return JSON.parse(json);
    } catch {
        throw new Error(`${file}: the plugin-ui block is empty or damaged; re-run inject`);
    }
}

export async function inject(file, source) {
    const text = await readFile(file, 'utf8');
    markedBlock(text, file);
    const kit = await readKit(source);
    await writeFile(file, text.replace(BLOCK, () => block(kit)));
    return hashes(kit);
}

export async function check(file, source) {
    const ui = vendored(await readFile(file, 'utf8'), file);
    const actual = hashes(ui);
    if (actual.css !== ui.sha256?.css || actual.js !== ui.sha256?.js) {
        throw new Error(`${file}: vendored plugin-ui was edited by hand; re-run inject instead`);
    }
    if (source) {
        const expected = hashes(await readKit(source));
        if (expected.css !== actual.css || expected.js !== actual.js) {
            throw new Error(`${file}: vendored plugin-ui is out of date with ${source}; re-run inject`);
        }
    }
    return actual;
}

const USAGE = `usage:
  node vendor.mjs hash [kitDir|kitUrl]
  node vendor.mjs inject <plugin.js> [kitDir|kitUrl]
  node vendor.mjs check <plugin.js> [kitDir|kitUrl]`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const [command, ...args] = process.argv.slice(2);
    try {
        if (command === 'hash') console.log(JSON.stringify({ version: KIT_VERSION, sha256: hashes(await readKit(args[0])) }, null, 2));
        else if (command === 'inject' && args[0]) console.log(JSON.stringify(await inject(args[0], args[1])));
        else if (command === 'check' && args[0]) console.log(JSON.stringify(await check(args[0], args[1])));
        else { console.error(USAGE); process.exitCode = 2; }
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
