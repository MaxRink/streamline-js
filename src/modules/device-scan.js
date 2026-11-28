const LEGACY_HOST_STATUSES = new Set([404, 405]);

export function createDeviceScanRequester(fetchFn) {
    let method = 'POST';
    return async function requestDeviceScan(url, init = {}) {
        if (method === 'POST') {
            const response = await fetchFn(url, { ...init, method: 'POST' });
            if (!LEGACY_HOST_STATUSES.has(response.status)) return response;
            method = 'GET';
        }
        return fetchFn(url, { ...init, method: 'GET' });
    };
}
