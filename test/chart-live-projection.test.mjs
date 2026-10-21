import assert from 'node:assert/strict';
import { test } from 'node:test';

import { destroyChart, renderChart } from '../src/modules/echarts-renderer.js';

function fixture(append = false) {
    const calls = [];
    const appends = [];
    const operations = [];
    const rendered = [];
    let disposed = 0;
    const chart = {
        setOption(option, settings) {
            calls.push({ option, settings });
            operations.push('setOption');
            for (const series of option.series || []) {
                if (!series.id.startsWith('trace-')) continue;
                rendered[Number(series.id.slice(6))] = series.data.map(point => [...point]);
            }
        },
        getOption: () => ({ legend: [{ selected: { Pressure: false } }] }),
        resize() {},
        dispose() { disposed++; }
    };
    if (append) chart.appendData = ({ seriesIndex, data }) => {
        appends.push({ seriesIndex, data });
        operations.push(`appendData-${seriesIndex}`);
        for (const point of data) rendered[seriesIndex].push([...point]);
    };
    return {
        calls, appends, operations, rendered,
        element: { clientWidth: 800, clientHeight: 400, style: {}, replaceChildren() {} },
        echarts: { init: () => chart },
        chart,
        disposed: () => disposed
    };
}

test('fallback without appendData extends stable projected arrays without touching earlier points', () => {
    const { calls, element, echarts } = fixture();
    const traces = [
        { name: 'Pressure', x: [0], y: [0] },
        { name: 'Flow', x: [0], y: [0] }
    ];
    const layout = { xaxis: { range: [0, 65] }, yaxis: {}, showlegend: true };
    globalThis.window = { devicePixelRatio: 1 };
    renderChart(echarts, element, traces, layout);
    const data = calls[0].option.series.map(series => series.data);
    const firstPoints = data.map(points => points[0]);

    for (let frame = 1; frame <= 600; frame++) {
        for (const trace of traces) {
            trace.x.push(frame / 10);
            trace.y.push(frame);
        }
        renderChart(echarts, element, traces, layout, 'live');
        const call = calls.at(-1);
        assert.deepEqual(call.option.series.map(series => series.id), ['trace-0', 'trace-1']);
        for (let index = 0; index < traces.length; index++) {
            assert.strictEqual(call.option.series[index].data, data[index]);
            assert.strictEqual(data[index][0], firstPoints[index]);
            assert.deepEqual(data[index].at(-1), [frame / 10, frame]);
            assert.equal(data[index].length, frame + 1);
            assert.equal(traces[index].x.length, traces[index].y.length);
        }
        assert.deepEqual(call.settings, { notMerge: false, lazyUpdate: true, silent: true });
        assert.equal(call.option.legend, undefined);
    }
    assert.deepEqual(traces[0].x, data[0].map(point => point[0]));
    assert.deepEqual(traces[0].y, data[0].map(point => point[1]));
    renderChart(echarts, element, traces, layout);
    assert.notStrictEqual(calls.at(-1).option.series[0].data, data[0]);
    assert.deepEqual(calls.at(-1).option.legend[0].selected, { Pressure: false });
    destroyChart(element);
});

test('a failed live setOption does not duplicate projected points on retry', () => {
    const { calls, appends, element, echarts, chart } = fixture(true);
    const traces = [{ x: [0], y: [0] }];
    globalThis.window = { devicePixelRatio: 1 };
    renderChart(echarts, element, traces, {});
    traces[0].x.push(1);
    traces[0].y.push(2);
    const setOption = chart.setOption;
    chart.setOption = () => { throw new Error('transient render failure'); };
    assert.throws(() => renderChart(echarts, element, traces, {}, 'live'), /transient render failure/);
    chart.setOption = setOption;
    renderChart(echarts, element, traces, {}, 'live');
    assert.deepEqual(calls.at(-1).option.series[0].data, [[0, 0], [1, 2]]);
    assert.equal(appends.length, 0);
    renderChart(echarts, element, traces, {}, 'live');
    assert.equal(Object.hasOwn(calls.at(-1).option, 'series'), false);
    assert.equal(appends.length, 0); // No new points must not append the prefix.
    destroyChart(element);
});

test('renderer invalidates projections on new sources, full render, trace count and disposal', () => {
    const { calls, appends, element, echarts, disposed } = fixture(true);
    const traces = [{ name: 'Pressure', x: [0, 1], y: [0, 9] }];
    const layout = { xaxis: {}, yaxis: {} };
    globalThis.window = { devicePixelRatio: 1 };
    renderChart(echarts, element, traces, layout);
    let previous = calls.at(-1).option.series[0].data;

    // A hidden chart may skip clear's full render, then resume live on new arrays.
    traces[0].x = [0];
    traces[0].y = [2];
    renderChart(echarts, element, traces, layout, 'live');
    assert.notStrictEqual(calls.at(-1).option.series[0].data, previous);
    assert.deepEqual(calls.at(-1).option.series[0].data, [[0, 2]]);
    previous = calls.at(-1).option.series[0].data;

    // Theme changes and finalizeLiveChart use the full-render path.
    renderChart(echarts, element, traces, { ...layout, paper_bgcolor: '#000' });
    assert.notStrictEqual(calls.at(-1).option.series[0].data, previous);
    assert.deepEqual(calls.at(-1).settings.replaceMerge, ['series', 'grid', 'xAxis', 'yAxis', 'legend']);
    previous = calls.at(-1).option.series[0].data;

    traces.push({ name: 'Flow', x: [0], y: [3] });
    renderChart(echarts, element, traces, layout, 'live');
    assert.notStrictEqual(calls.at(-1).option.series[0].data, previous);
    assert.equal(calls.at(-1).settings.lazyUpdate, false);
    previous = calls.at(-1).option.series[0].data;
    destroyChart(element);
    renderChart(echarts, element, traces, layout, 'live');
    assert.equal(disposed(), 1);
    assert.notStrictEqual(calls.at(-1).option.series[0].data, previous);
    assert.equal(calls.at(-1).settings.lazyUpdate, false);
    assert.equal(appends.length, 0); // All invalidations must replace, never append old-shot data.
    destroyChart(element);
});

test('600-frame live replay sends series only for layout changes and appends only new pairs', t => {
    const { calls, appends, operations, rendered, element, echarts } = fixture(true);
    const traces = Array.from({ length: 9 }, (_, index) => ({
        name: index === 0 ? 'Pressure' : `Series ${index}`, x: [0], y: [index],
        ...(index >= 5 ? { xaxis: 'x2', yaxis: 'y2' } : {})
    }));
    const layout = {
        xaxis: { range: [0, 1], autorange: false, dtick: 1 },
        xaxis2: { range: [0, 1], autorange: false, dtick: 1 },
        yaxis: { range: [0, 1000], autorange: false },
        yaxis2: { range: [0, 1000], autorange: false },
        showlegend: true
    };
    globalThis.window = { devicePixelRatio: 1 };
    renderChart(echarts, element, traces, layout);
    assert.deepEqual(calls[0].option.series.map(series => series.id), traces.map((_, index) => `trace-${index}`));
    for (let frame = 1; frame <= 600; frame++) {
        for (let index = 0; index < traces.length; index++) {
            traces[index].x.push(frame / 10);
            traces[index].y.push(frame + index);
        }
        layout.xaxis.range = layout.xaxis2.range = [0, frame / 10 / 0.93];
        if (frame === 200) layout.shapes = [{ x0: 20 }];
        if (frame === 400) layout.yaxis.range = [0, 1100];
        if (frame === 500) layout.xaxis.dtick = 5;
        const layoutChanged = [200, 400, 500].includes(frame);
        const appendCount = appends.length;
        operations.length = 0;
        renderChart(echarts, element, traces, layout, 'live');
        const call = calls.at(-1);
        assert.equal(Object.hasOwn(call.option, 'series'), layoutChanged);
        assert.deepEqual(call.settings, { notMerge: false, lazyUpdate: true, silent: true });
        assert.equal(call.option.legend, undefined);
        assert.equal(appends.length - appendCount, layoutChanged ? 0 : 9);
        assert.deepEqual(operations, ['setOption', ...(layoutChanged ? [] : traces.map((_, index) => `appendData-${index}`))]);
        if (layoutChanged) {
            assert.deepEqual(call.option.series.slice(0, 9).map(series => series.id), traces.map((_, index) => `trace-${index}`));
            assert.equal(call.option.series[0].data.length, frame + 1);
            assert.deepEqual([call.option.yAxis[0].min, call.option.yAxis[0].max], layout.yaxis.range);
        } else {
            assert.equal(call.option.yAxis, undefined);
            for (let index = 0; index < traces.length; index++) {
                assert.deepEqual(appends[appendCount + index], { seriesIndex: index, data: [[frame / 10, frame + index]] });
            }
        }
        for (let index = 0; index < traces.length; index++) {
            assert.equal(traces[index].x.length, traces[index].y.length);
            assert.deepEqual(rendered[index], traces[index].x.map((x, i) => [x, traces[index].y[i]]));
        }
    }
    assert.equal(calls.filter(call => Object.hasOwn(call.option, 'series')).length, 4);
    assert.equal(appends.length, 5373);
    t.diagnostic(`600 live flushes: 4 setOption-with-series (initial + 3 layout changes), ${appends.length} delta-only appendData calls`);
    renderChart(echarts, element, traces, layout);
    assert.deepEqual(calls.at(-1).option.legend[0].selected, { Pressure: false });
    destroyChart(element);
});

test('main and expanded instances append against their own lengths and catch up in batches', () => {
    const main = fixture(true);
    const expanded = fixture(true);
    const traces = [{ x: [0], y: [0] }, { x: [0], y: [1] }];
    const layout = { xaxis: { range: [0, 10], autorange: false }, yaxis: { range: [0, 10], autorange: false } };
    globalThis.window = { devicePixelRatio: 1 };
    renderChart(main.echarts, main.element, traces, layout);
    for (const trace of traces) { trace.x.push(1); trace.y.push(2); }
    renderChart(main.echarts, main.element, traces, layout, 'live');
    renderChart(expanded.echarts, expanded.element, traces, layout); // Opens one frame later.
    for (const trace of traces) { trace.x.push(2); trace.y.push(3); }
    renderChart(expanded.echarts, expanded.element, traces, layout, 'live');
    for (const trace of traces) { trace.x.push(3); trace.y.push(4); }
    renderChart(main.echarts, main.element, traces, layout, 'live');
    renderChart(expanded.echarts, expanded.element, traces, layout, 'live');
    assert.deepEqual(main.appends.map(call => call.data), [[[1, 2]], [[1, 2]], [[2, 3], [3, 4]], [[2, 3], [3, 4]]]);
    assert.deepEqual(expanded.appends.map(call => call.data), [[[2, 3]], [[2, 3]], [[3, 4]], [[3, 4]]]);
    assert.deepEqual(main.rendered, expanded.rendered);
    assert.deepEqual(main.rendered, traces.map(trace => trace.x.map((x, index) => [x, trace.y[index]])));
    destroyChart(main.element);
    destroyChart(expanded.element);
});

test('a partial append failure propagates and retry replaces every series before appending again', () => {
    const { calls, appends, rendered, element, echarts, chart } = fixture(true);
    const traces = [{ x: [0], y: [0] }, { x: [0], y: [1] }];
    globalThis.window = { devicePixelRatio: 1 };
    renderChart(echarts, element, traces, {});
    for (const trace of traces) { trace.x.push(1); trace.y.push(2); }
    const appendData = chart.appendData;
    chart.appendData = payload => {
        if (payload.seriesIndex === 1) throw new Error('append failure');
        appendData(payload);
    };
    assert.throws(() => renderChart(echarts, element, traces, {}, 'live'), /append failure/);
    assert.equal(appends.length, 1);
    chart.appendData = appendData;
    renderChart(echarts, element, traces, {}, 'live');
    assert.equal(appends.length, 1);
    assert.equal(calls.at(-1).option.series.length, 2);
    assert.deepEqual(rendered, [[[0, 0], [1, 2]], [[0, 1], [1, 2]]]);
    for (const trace of traces) { trace.x.push(2); trace.y.push(3); }
    renderChart(echarts, element, traces, {}, 'live');
    assert.equal(Object.hasOwn(calls.at(-1).option, 'series'), false);
    assert.deepEqual(appends.slice(1), [0, 1].map(seriesIndex => ({ seriesIndex, data: [[2, 3]] })));
    assert.deepEqual(rendered, [[[0, 0], [1, 2], [2, 3]], [[0, 1], [1, 2], [2, 3]]]);
    destroyChart(element);
});
