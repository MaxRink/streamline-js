#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, inject } from './vendor.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const dir = await mkdtemp(join(tmpdir(), 'plugin-ui-'));
try {
    const plugin = join(dir, 'plugin.js');
    await writeFile(plugin, 'function createPlugin(host) {\n/* plugin-ui:begin */\n/* plugin-ui:end */\nreturn {};\n}\n');
    const injected = await inject(plugin);
    assert.deepEqual(await check(plugin, here), injected);
    assert.deepEqual(await check(plugin), injected);
    const text = await readFile(plugin, 'utf8');
    await writeFile(plugin, text.replace('--pu-tap:56px', '--pu-tap:40px'));
    await assert.rejects(check(plugin), /edited by hand/);
    const olderKit = await mkdtemp(join(dir, 'kit-'));
    await writeFile(join(olderKit, 'plugin-ui.css'), (await readFile(join(here, 'plugin-ui.css'), 'utf8')).replace('--pu-tap:56px', '--pu-tap:40px'));
    await writeFile(join(olderKit, 'plugin-ui.js'), await readFile(join(here, 'plugin-ui.js'), 'utf8'));
    await inject(plugin, olderKit);
    await check(plugin);
    await assert.rejects(check(plugin, here), /out of date/);
    await writeFile(plugin, 'no markers');
    await assert.rejects(inject(plugin), /no \/\* plugin-ui:begin/);
    console.log('vendor: ok');
} finally {
    await rm(dir, { recursive: true, force: true });
}

let chromium;
try {
    ({ chromium } = await import('playwright'));
} catch {
    console.log('render: skipped (playwright not installed)');
    process.exit(0);
}
const browser = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }));
try {
    for (const [theme, width] of [['light', 412], ['dark', 412], ['light', 1280], ['dark', 1280]]) {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        await page.goto(`file://${join(here, 'demo.html')}?theme=${theme}&lang=de`);
        const report = await page.evaluate(() => {
            const visible = el => el.getClientRects().length > 0;
            const tooSmall = (selector, min) => [...document.querySelectorAll(selector)].filter(visible)
                .filter(el => el.getBoundingClientRect().height < min).map(el => el.outerHTML.slice(0, 60));
            const steps = [];
            const next = document.querySelector('[data-pu-next]');
            document.getElementById('host').value = 'grinder.local';
            return (async () => {
                for (let i = 0; i < 4; i += 1) {
                    steps.push([...tooSmall('.pu-btn', 56), ...tooSmall('input:not([type=checkbox]):not([type=radio]), select, .pu-choice label, summary', 48)]);
                    if (!next.hidden) { next.click(); await new Promise(r => setTimeout(r, 0)); }
                }
                return {
                    small: steps.flat(),
                    overflow: document.documentElement.scrollWidth > innerWidth,
                    themeAttr: document.documentElement.dataset.theme,
                    bg: getComputedStyle(document.body).backgroundColor,
                    stepper: document.querySelector('[data-pu-stepper] span').textContent,
                    back: document.querySelector('[data-pu-back]').textContent,
                };
            })();
        });
        assert.deepEqual(report.small, [], `${theme}@${width}: undersized targets`);
        assert.equal(report.overflow, false, `${theme}@${width}: horizontal overflow`);
        assert.equal(report.themeAttr, theme);
        assert.equal(report.bg, theme === 'dark' ? 'rgb(16, 18, 23)' : 'rgb(255, 255, 255)');
        assert.equal(report.stepper, 'Schritt 4 von 4');
        assert.equal(report.back, 'Zurück');
        await page.close();
    }
    console.log('render: ok');
} finally {
    await browser.close();
}
