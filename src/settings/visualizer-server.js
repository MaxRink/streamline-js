export const DEFAULT_VISUALIZER_SERVER_URL = 'https://visualizer.coffee';

/**
 * Return the canonical base URL used by the Visualizer plugin.
 *
 * A path prefix is intentional: installations behind a reverse proxy can use
 * e.g. https://coffee.example/visualizer. Query strings, fragments, embedded
 * credentials, dot segments and backslashes are rejected so the same value can
 * safely be used for every Visualizer request. HTTP is allowed for local/LAN
 * self-hosting; the settings page explains that it sends credentials and shot
 * data without transport encryption.
 */
export function normalizeVisualizerServerUrl(value) {
    const raw = String(value ?? '');
    if (!raw) return DEFAULT_VISUALIZER_SERVER_URL;
    if (/\s|\\/.test(raw)) throw new Error('Visualizer server URL cannot contain whitespace or backslashes');

    const authorityEnd = raw.search(/[/?#]/);
    const pathAndQuery = authorityEnd < 0 ? '' : raw.slice(authorityEnd);
    if (/(^|\/)\.{1,2}(?=\/|$)/.test(pathAndQuery) || /%2e/i.test(pathAndQuery)) {
        throw new Error('Visualizer server URL cannot contain dot path segments');
    }

    let url;
    try {
        url = new URL(raw);
    } catch {
        throw new Error('Enter a complete HTTP or HTTPS Visualizer server URL');
    }
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.search || url.hash) {
        throw new Error('Visualizer server URL must use HTTP or HTTPS without credentials, queries, or fragments');
    }

    const path = url.pathname.replace(/\/+$/, '');
    return `${url.origin}${path}`;
}

export function isInsecureVisualizerServerUrl(value) {
    try {
        return normalizeVisualizerServerUrl(value).startsWith('http://');
    } catch {
        return false;
    }
}

export function visualizerServerUrlsEqual(left, right) {
    try {
        return normalizeVisualizerServerUrl(left) === normalizeVisualizerServerUrl(right);
    } catch {
        return false;
    }
}
