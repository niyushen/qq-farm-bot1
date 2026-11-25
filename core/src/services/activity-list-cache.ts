export {};

const { performance } = require('node:perf_hooks');
const { createSharedRead } = require('../utils/shared-read');
const { getExecutionScope } = require('../utils/execution-scope');

type ActivityListLoader<T> = (loadId: number) => Promise<T>;
type Clock = () => number;
type ActivityListAccessSource = 'network' | 'pending' | 'cache';

interface ActivityListAccess {
    source: ActivityListAccessSource;
    loadId: number;
    ageMs: number;
}

type ActivityListAccessObserver = (access: ActivityListAccess) => void;

function createActivityListCache<T>(loader: ActivityListLoader<T>, clock: Clock = () => performance.now()) {
    let cached: T | null = null;
    let loadedAt = 0;
    let cachedLoadId = 0;
    let pending: { loadId: number; startedAt: number; started: boolean } | null = null;
    const sharedRead = createSharedRead();
    let invalidationRevision = 0;
    let nextLoadId = 1;
    let cachedBytes = 0;
    const maxCachedBytes = 2 * 1024 * 1024;

    function reportAccess(observer: ActivityListAccessObserver | undefined, access: ActivityListAccess): void {
        if (!observer) return;
        try {
            observer(access);
        } catch {
            // Diagnostics must never affect the activity request.
        }
    }

    async function get(maxAgeMs = 0, observer?: ActivityListAccessObserver, readerOptions: any = {}): Promise<T> {
        const scope = readerOptions.scope === undefined ? getExecutionScope() : readerOptions.scope;
        const blocked = scope?.check() || (readerOptions.signal?.aborted ? readerOptions.signal.reason : null);
        if (blocked) throw blocked;
        const reuseWindowMs = Number.isFinite(Number(maxAgeMs)) ? Math.max(0, Math.min(300_000, Number(maxAgeMs))) : 0;
        const now = clock();
        if (cached !== null && reuseWindowMs > 0 && now - loadedAt <= reuseWindowMs) {
            reportAccess(observer, {
                source: 'cache',
                loadId: cachedLoadId,
                ageMs: Math.max(0, now - loadedAt),
            });
            return cached;
        }
        if (pending && sharedRead.stats().pending === 0) pending = null;
        const joined = !!pending;
        const pendingRequest = pending || { loadId: nextLoadId++, startedAt: now, started: false };
        pending = pendingRequest;
        const loadRevision = invalidationRevision;
        reportAccess(observer, { source: joined ? 'pending' : 'network', loadId: pendingRequest.loadId, ageMs: Math.max(0, now - pendingRequest.startedAt) });
        try {
            return await sharedRead.get(async () => {
                pendingRequest.started = true;
                const loadScope = getExecutionScope();
                const value = await loader(pendingRequest.loadId);
                if (loadRevision === invalidationRevision && pending === pendingRequest && !loadScope?.check()) {
                    let bytes = maxCachedBytes + 1;
                    try { bytes = Buffer.byteLength(JSON.stringify(value) || ''); } catch { /* Unserializable values are not retained. */ }
                    cached = bytes <= maxCachedBytes ? value : null;
                    cachedBytes = cached === null ? 0 : bytes;
                    // TTL starts before the request, rather than making a slow
                    // response artificially younger than its snapshot.
                    loadedAt = pendingRequest.startedAt;
                    cachedLoadId = pendingRequest.loadId;
                }
                return value;
            }, readerOptions);
        } catch (error) {
            if (!pendingRequest.started && pending === pendingRequest) pending = null;
            throw error;
        }
    }

    function invalidate(options: { cancelPending?: boolean; reason?: any } = {}): void {
        invalidationRevision += 1;
        cached = null;
        loadedAt = 0;
        cachedLoadId = 0;
        cachedBytes = 0;
        pending = null;
        sharedRead.invalidate(options.reason, options.cancelPending === true);
    }

    return { get, invalidate, stats: () => ({ ...sharedRead.stats(), cached: cached !== null ? 1 : 0, cachedBytes }) };
}

module.exports = { createActivityListCache };
