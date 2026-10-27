import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');

test('the chart bundle is modular ECharts without Plotly assets', () => {
    const entry = read('scripts/echarts-streamline-entry.js');
    const asset = new URL('src/modules/echarts-streamline.min.js', root);
    for (const feature of ['LineChart', 'GridComponent', 'LegendComponent', 'MarkLineComponent', 'MarkPointComponent', 'CanvasRenderer']) {
        assert.match(entry, new RegExp(`\\b${feature}\\b`));
    }
    assert.equal(existsSync(new URL('src/modules/plotly-basic-3.1.0.min.js', root)), false);
    assert.ok(statSync(asset).size < 600_000);
});

test('main chart rendering uses the ECharts renderer without sampling', () => {
    const chart = read('src/modules/chart.js');
    const renderer = read('src/modules/echarts-renderer.js');
    assert.match(chart, /chartRedrawInterval = observeChartFrame\(performance\.now\(\)\)/);
    assert.match(chart, /chartRedrawInterval - \(performance\.now\(\) - lastRedrawAt\)/);
    assert.match(chart, /renderChart\(echarts, element, traces, layout, mode\)/);
    assert.match(renderer, /renderer: 'canvas'/);
    assert.match(renderer, /animation: false/);
    assert.doesNotMatch(renderer, /sampling:/);
    assert.doesNotMatch(chart + renderer, /Plotly\./);
});

test('live rendering stays paint-aligned and skips hidden charts', () => {
    const chart = read('src/modules/chart.js');
    assert.match(chart, /if \(document\.visibilityState === 'hidden'\) return false/);
    assert.match(chart, /redrawFrame = requestAnimationFrame\(\(\) => \{\s*redrawFrame = 0;\s*flushChart\(\)/);
    assert.match(chart, /document\.addEventListener\('visibilitychange', handleChartVisibilityChange\)/);
    assert.match(chart, /observedChartSize = \{ width: element\.clientWidth, height: element\.clientHeight \}/);
});

test('expanded mode is a layout mode of the main page drawing one single-axis plot', () => {
    const chart = read('src/modules/chart.js');
    const index = read('index.html');
    const css = read('src/css/main.css');
    assert.match(index, /id="expanded-chart"/);
    assert.doesNotMatch(index, /expanded-chart-overlay|expanded-chart-back/);
    assert.doesNotMatch(index, /id="expanded-(flow|temp)-chart"/);
    assert.match(css, /#main-page\.chart-zoomed #plotly-chart/);
    assert.match(chart, /classList\.add\('chart-zoomed'\)/);
    assert.match(chart, /renderECharts\(element, traces, layout, mode\)/);
    assert.match(chart, /showlegend: false/);
    assert.match(chart, /addEventListener\('streamline:mainpagehidden', handleMainPageHidden\)/);
});

test('hidden renders coalesce and teardown invalidates queued work before disposal', () => {
    const chart = read('src/modules/chart.js');
    assert.match(chart, /if \(expandedOpen\) \{\s*mainRenderDirty = true;\s*return;\s*\}\s*const element = getChartElement\(\);\s*if \(!element \|\| element\.offsetParent === null\) \{\s*mainRenderDirty = true/);
    assert.match(chart, /if \(mainRenderDirty && latestMainRender && !expandedOpen\)/);
    assert.match(chart, /renderGenerations\.set\(element, generation\);[\s\S]*await enqueue\?\.dispose\(\);[\s\S]*destroyChart\(element\)/);
    assert.match(chart, /!element\.isConnected \|\| renderGenerations\.get\(element\) !== generation/g);
});

test('the profile preview leaves a running shot\'s chart state alone', () => {
    const chart = readFileSync(new URL('../src/modules/chart.js', import.meta.url), 'utf8');
    const start = chart.indexOf('export function plotProfile(');
    const body = chart.slice(start, chart.indexOf('function drawProfilePreview(', start));
    assert.match(body, /if \(!isLiveShot\)/, 'idle keeps the preview-owns-the-chart behavior');
    assert.match(body, /liveArrays\[trace\] = \{ x: chartData\[trace\]\.x, y: chartData\[trace\]\.y \}/, 'live arrays are saved');
    assert.match(body, /finally \{[\s\S]*chartData\[trace\]\.x = liveArrays\[trace\]\.x;[\s\S]*latestMainRender = priorRender;/, 'and restored in a finally');
    const draw = chart.slice(chart.indexOf('function drawProfilePreview('));
    assert.match(draw, /if \(!isolated\) rebuildExpandedFromChartData\(\)/, 'the live shot\'s expanded tracking is not reset');
    assert.match(draw, /if \(!isolated\) \{\s*clearChart\(\);/, 'clearChart (which wipes the shot) is not used for an isolated preview');
});
