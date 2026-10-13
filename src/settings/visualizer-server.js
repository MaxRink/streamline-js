export const DEFAULT_VISUALIZER_SERVER_URL = 'https://visualizer.coffee';

/**
 * Return the canonical base URL used by the Visualizer plugin.
 *
 * A path prefix is intentional: installations behind a reverse proxy can use
 * e.g. https://coffee.example/visualizer. Query strings, fragments, embedded
 * credentials and non-HTTPS origins are rejected so the same value can safely
 * be used for every Visualizer request.
 */
export function normalizeVisualizerServerUrl(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return DEFAULT_VISUALIZER_SERVER_URL;

    let url;
    try {
        url = new URL(raw);
    } catch {
        throw new Error('Enter a complete HTTPS Visualizer server URL');
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
        throw new Error('Visualizer server URL must use HTTPS without credentials, queries, or fragments');
    }

    const path = url.pathname.replace(/\/+$/, '');
    return `${url.origin}${path}`;
}

export function visualizerServerUrlsEqual(left, right) {
    try {
        return normalizeVisualizerServerUrl(left) === normalizeVisualizerServerUrl(right);
    } catch {
        return false;
    }
}
