// Match the historical 10 Hz gate until a positive frame interval is observed.
export const DEFAULT_CHART_INTERVAL_MS = 100;
export const MIN_CHART_INTERVAL_MS = 100;
export const MAX_CHART_INTERVAL_MS = 100;

// Observe accepted updateChart arrivals, not machine timestamps. The floor equals
// the historical 100 ms gate, so painting is never faster than before until a
// lower floor is verified on a tablet; the EMA clamp is kept so that can change.
export function createChartCadence() {
    let lastFrameAt = null;
    let estimate = null;
    return now => {
        const delta = lastFrameAt === null ? NaN : now - lastFrameAt;
        lastFrameAt = Number.isFinite(now) ? now : null;
        if (!Number.isFinite(delta) || delta <= 0) {
            estimate = null;
            return DEFAULT_CHART_INTERVAL_MS;
        }
        const smoothed = estimate === null ? delta : estimate * 0.75 + delta * 0.25;
        estimate = Math.max(MIN_CHART_INTERVAL_MS, Math.min(MAX_CHART_INTERVAL_MS, smoothed));
        return estimate;
    };
}

// Live source arrays are append-only. Replacing either array or truncating it
// starts a new projection; never modify the source used by full/history renders.
export function projectTraceDelta(trace, previous) {
    const length = trace.x.length;
    const reset = !previous || previous.x !== trace.x || previous.y !== trace.y || previous.length > length;
    const points = [];
    for (let index = reset ? 0 : previous.length; index < length; index++) {
        points.push([trace.x[index], trace.y[index]]);
    }
    return { x: trace.x, y: trace.y, length, reset, points };
}
