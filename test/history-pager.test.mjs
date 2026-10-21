import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createHistoryPager, getAuthoritativeRange, isInPruneRange, isShotAlreadyDeleted } from '../src/modules/history-pager.js';

const shots = count => Array.from({ length: count }, (_, index) => ({
    id: `shot-${index}`,
    timestamp: new Date(index * 1000).toISOString()
})).reverse();

test('offline history pages every cached summary', async () => {
    const cached = shots(55);
    const pager = createHistoryPager({
        pageSize: 20,
        fetchServerPage: async () => { throw new Error('offline'); },
        fetchSummaryPage: async (offset, limit) => cached.slice(offset, offset + limit),
        fetchCachedPage: async () => []
    });

    let page = await pager.initial();
    page = await pager.more();
    page = await pager.more();
    assert.equal(page.shots.length, 55);
    assert.deepEqual(page.shots.map(shot => shot.id), cached.map(shot => shot.id));
    assert.equal(page.hasMore, true);
});

test('server and cache use independent offsets and merge duplicate ids', async () => {
    const offsets = [];
    const local = shots(20).map(shot => ({ ...shot, local: true }));
    const server = [{ ...local[0], server: true }, { id: 'server-only', timestamp: new Date(30000).toISOString() }];
    const pager = createHistoryPager({
        pageSize: 20,
        fetchServerPage: async offset => {
            offsets.push(offset);
            return { items: offset === 0 ? server : [], total: 50 };
        },
        fetchSummaryPage: async () => local,
        fetchCachedPage: async () => []
    });

    const page = await pager.initial();
    assert.deepEqual(offsets, [0]);
    assert.equal(page.shots.length, 21);
    assert.equal(page.shots.filter(shot => shot.id === local[0].id).length, 1);
    assert.equal(page.shots.find(shot => shot.id === local[0].id).server, true);
});

test('simultaneous loads share one page request and a failed page stays retryable', async () => {
    let calls = 0;
    let online = false;
    let release;
    const pager = createHistoryPager({
        pageSize: 20,
        fetchServerPage: async offset => {
            calls += 1;
            assert.equal(offset, 0);
            if (!online) throw new Error('offline');
            await new Promise(resolve => { release = resolve; });
            return { items: [{ id: 'server', timestamp: new Date(1000).toISOString() }], total: 1 };
        },
        fetchSummaryPage: async () => [],
        fetchCachedPage: async () => []
    });

    const failedPage = await pager.initial();
    assert.equal(failedPage.hasMore, true);
    assert.equal(pager.hasMore(), true);
    online = true;
    const first = failedPage.hasMore ? pager.more() : Promise.resolve(failedPage);
    const second = pager.more();
    const third = pager.more();
    assert.equal(calls, 2);
    release();
    const pages = await Promise.all([first, second, third]);
    assert.equal(calls, 2);
    assert.equal(pages[0].shots.length, 1);
});

test('initial starts a new generation while more is in flight', async () => {
    const offsets = [];
    let zeroPage = 0;
    let releaseOldPage;
    const pager = createHistoryPager({
        pageSize: 1,
        fetchServerPage: offset => {
            offsets.push(offset);
            if (offset === 1) {
                return new Promise(resolve => { releaseOldPage = () => resolve({
                    items: [{ id: 'stale', timestamp: new Date(1000).toISOString() }],
                    total: 2
                }); });
            }
            zeroPage += 1;
            return Promise.resolve({
                items: [{ id: zeroPage === 1 ? 'initial' : 'refreshed', timestamp: new Date(3000).toISOString() }],
                total: 2
            });
        },
        fetchSummaryPage: async () => [],
        fetchCachedPage: async () => []
    });

    await pager.initial();
    const oldMore = pager.more();
    const refreshed = await pager.initial();
    releaseOldPage();
    await oldMore;

    assert.deepEqual(offsets, [0, 1, 0]);
    assert.deepEqual(refreshed.shots.map(shot => shot.id), ['refreshed']);
});

test('updated shots are not replaced by stale later pages', async () => {
    const oldShot = { id: 'shot', timestamp: new Date(1000).toISOString(), title: 'old' };
    let pageNumber = 0;
    const pager = createHistoryPager({
        pageSize: 1,
        fetchServerPage: async () => ({ items: [], total: 0 }),
        fetchSummaryPage: async () => pageNumber++ < 2 ? [oldShot] : [],
        fetchCachedPage: async () => []
    });

    await pager.initial();
    pager.update({ ...oldShot, title: 'new' });
    const page = await pager.more();
    assert.equal(page.shots[0].title, 'new');
});

const at = (id, seconds) => ({ id, timestamp: new Date(seconds * 1000).toISOString() });

test('prune range is open at the newest edge only on page 0 and the oldest only at the end', () => {
    const items = [at('c', 30), at('b', 20)];
    assert.deepEqual(getAuthoritativeRange({ items, total: 5 }, 0), { newer: null, older: items[1].timestamp, keepIds: ['c', 'b'] });
    assert.deepEqual(getAuthoritativeRange({ items, total: 5 }, 1), { newer: items[0].timestamp, older: items[1].timestamp, keepIds: ['c', 'b'] });
    assert.equal(getAuthoritativeRange({ items, total: 3 }, 1).older, null);
    assert.equal(getAuthoritativeRange({ items }, 1).older, items[1].timestamp);
    assert.equal(getAuthoritativeRange({ items: [], total: 0 }, 0), null);
    assert.equal(getAuthoritativeRange({ items: [{ id: 'x', timestamp: 'nope' }], total: 1 }, 0), null);
});

test('prune range excludes boundaries, kept ids and bad timestamps', () => {
    const range = getAuthoritativeRange({ items: [at('c', 30), at('a', 10)], total: 9 }, 2);
    assert.equal(isInPruneRange(at('gone', 20), range), true);
    assert.equal(isInPruneRange(at('c', 30), range), false);
    assert.equal(isInPruneRange(at('tie-newer', 30), range), false);
    assert.equal(isInPruneRange(at('tie-older', 10), range), false);
    assert.equal(isInPruneRange(at('newer', 40), range), false);
    assert.equal(isInPruneRange(at('older', 5), range), false);
    assert.equal(isInPruneRange({ id: 'bad', timestamp: 'x' }, range), false);
});

test('cached shots missing from a successful server page are pruned, including newer than page 0', async () => {
    const local = [at('new', 50), at('server-a', 40), at('deleted', 30), at('server-b', 20), at('old', 10)];
    const pruned = [];
    const pager = createHistoryPager({
        pageSize: 3,
        fetchServerPage: async () => ({ items: [at('server-a', 40), at('server-b', 20)], total: 9 }),
        fetchSummaryPage: async () => local,
        fetchCachedPage: async () => [],
        pruneShots: async range => { pruned.push(range); return { summaries: [30000], cached: [] }; }
    });
    const page = await pager.initial();
    assert.deepEqual(page.shots.map(shot => shot.id), ['server-a', 'server-b', 'old']);
    assert.equal(pruned.length, 1);
    assert.equal(pruned[0].newer, null);
    assert.deepEqual(page.errors, []);
});

test('failed or empty server pages prune nothing', async () => {
    const local = [at('a', 20), at('b', 10)];
    let calls = 0;
    for (const fetchServerPage of [async () => { throw new Error('offline'); }, async () => ({ items: [], total: 0 })]) {
        const pager = createHistoryPager({
            pageSize: 20,
            fetchServerPage,
            fetchSummaryPage: async () => local,
            fetchCachedPage: async () => [],
            pruneShots: async () => { calls += 1; return {}; }
        });
        assert.equal((await pager.initial()).shots.length, 2);
    }
    assert.equal(calls, 0);
});

test('pruned rows in the consumed region shift the store offsets', async () => {
    const local = [at('a', 60), at('gone', 50), at('b', 40), at('c', 30)];
    const offsets = [];
    const pager = createHistoryPager({
        pageSize: 3,
        fetchServerPage: async () => ({ items: [at('a', 60), at('b', 40), at('c', 30)], total: 3 }),
        fetchSummaryPage: async offset => { offsets.push(offset); return local.slice(offset, offset + 3); },
        fetchCachedPage: async () => [],
        pruneShots: async () => ({ summaries: [50000], cached: [] })
    });
    await pager.initial();
    await pager.more();
    assert.deepEqual(offsets, [0, 2]);
});

test('a prune failure is reported without losing the page', async () => {
    const pager = createHistoryPager({
        pageSize: 3,
        fetchServerPage: async () => ({ items: [at('a', 20)], total: 1 }),
        fetchSummaryPage: async () => [at('a', 20), at('x', 10)],
        fetchCachedPage: async () => [],
        pruneShots: async () => { throw new Error('idb'); }
    });
    const page = await pager.initial();
    assert.deepEqual(page.shots.map(shot => shot.id), ['a']);
    assert.equal(page.errors.length, 1);
});

test('only a 404 delete response counts as already deleted', () => {
    assert.equal(isShotAlreadyDeleted(404), true);
    for (const status of [400, 403, 500, 503]) assert.equal(isShotAlreadyDeleted(status), false);
});
