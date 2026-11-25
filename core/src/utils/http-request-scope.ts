export {};
const { performance } = require('node:perf_hooks');

/** Own external HTTP requests for one WASM runtime, including DNS and body time. */
function createHttpRequestScope(options: { maxPending?: number; now?: () => number; backoffMs?: number; maxBackoffMs?: number } = {}) {
    const maxPending = Math.max(1, options.maxPending || 4);
    const now = options.now || (() => performance.now());
    const active = new Set<any>();
    const counters = { started: 0, completed: 0, failed: 0, timedOut: 0, aborted: 0, rejected: 0 };
    let destroyed = false;
    let failures = 0;
    let retryAt = 0;

    function start(factory: () => any, deadlineMs: number): any | null {
        if (destroyed || active.size >= maxPending || now() < retryAt) { counters.rejected++; return null; }
        const entry: any = { at: now(), request: null, response: null, done: false, timer: null };
        active.add(entry);
        const retire = (reason: keyof typeof counters) => {
            if (entry.done) return;
            entry.done = true;
            clearTimeout(entry.timer);
            active.delete(entry);
            counters[reason]++;
            if (reason === 'failed' || reason === 'timedOut') {
                failures++;
                retryAt = now() + Math.min(options.maxBackoffMs || 30000, (options.backoffMs || 0) * 2 ** Math.min(failures - 1, 10));
            } else if (reason === 'completed') { failures = 0; retryAt = 0; }
            entry.response?.removeListener('end', onEnd);
            entry.response?.removeListener('close', onEnd);
            // Keep the one-shot error guard until close when destroy emits asynchronously.
        };
        function onEnd() { retire('completed'); }
        const onError = () => retire('failed');
        const onClose = () => {
            retire('completed');
            entry.request?.removeListener('error', onError);
            entry.request?.removeListener('response', onResponse);
            entry.response?.removeListener('error', onError);
        };
        function onResponse(response: any) {
            entry.response = response;
            if (entry.done || destroyed) { response.destroy(); return; }
            response.once('end', onEnd);
            response.once('close', onEnd);
            response.once('error', onError);
        }
        entry.stop = (reason: 'timedOut' | 'aborted') => {
            if (entry.done) return;
            retire(reason);
            entry.response?.destroy();
            entry.request?.destroy();
        };
        try {
            entry.request = factory();
            counters.started++;
            entry.request.once('error', onError);
            entry.request.once('close', onClose);
            entry.request.once('response', onResponse);
            entry.timer = setTimeout(() => entry.stop('timedOut'), Math.max(1, deadlineMs));
            entry.timer.unref?.();
            return entry.request;
        } catch (error) { retire('failed'); throw error; }
    }

    function destroy(): void {
        destroyed = true;
        for (const entry of [...active]) entry.stop('aborted');
    }

    return {
        start, destroy,
        snapshot: () => ({ ...counters, pending: active.size,
            retryAfterMs: Math.max(0, retryAt - now()),
            oldestAgeMs: active.size ? Math.max(...[...active].map(entry => now() - entry.at)) : 0 }),
    };
}

module.exports = { createHttpRequestScope };
