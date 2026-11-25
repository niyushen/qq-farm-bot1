export {};

const WINDOW_MS = 10 * 60 * 1000;
const BUCKET_MS = 30000;
const { WindowMetrics } = require('./window-metrics');

/** Bounded counters collected at task transitions, including work between samples. */
class TaskDiagnostics {
    private buckets: any[] = [];
    private recent: any[] = [];
    private readonly since: number;
    private readonly types: any;

    constructor(private readonly now: () => number) { this.since = now(); this.types = new WindowMetrics(now); }

    private prune(now: number): void {
        this.buckets = this.buckets.filter(item => item.at + BUCKET_MS > now - WINDOW_MS);
        this.recent = this.recent.filter(item => item.mono > now - WINDOW_MS);
    }

    private bucket(): any {
        const now = this.now();
        this.prune(now);
        const at = Math.floor(now / BUCKET_MS) * BUCKET_MS;
        let bucket = this.buckets[this.buckets.length - 1];
        if (!bucket || bucket.at !== at) {
            bucket = { at, submitted: 0, completed: 0, failed: 0, cancelled: 0, expired: 0, rejected: 0, coalesced: 0,
                peakQueued: 0, maxWaitMs: 0, maxRunMs: 0 };
            this.buckets.push(bucket);
        }
        return bucket;
    }

    count(kind: string, queued = 0): void {
        const bucket = this.bucket();
        bucket[kind]++;
        bucket.peakQueued = Math.max(bucket.peakQueued, queued);
    }

    finish(task: any, error?: any): void {
        const now = this.now();
        const started = task.startedMonoAt !== undefined;
        const outcome = !error ? 'completed' : error?.code === 'ACCOUNT_TASK_QUEUE_TIMEOUT' ? 'expired'
            : !started || ['ACCOUNT_OFFLINE', 'EXECUTION_CANCELLED', 'ABORT_ERR'].includes(error?.code) || error?.name === 'AbortError'
                ? 'cancelled' : 'failed';
        const waitMs = Math.max(0, (started ? task.startedMonoAt : now) - task.queuedMonoAt);
        const runMs = started ? Math.max(0, now - task.startedMonoAt) : 0;
        const bucket = this.bucket();
        bucket[outcome]++;
        bucket.maxWaitMs = Math.max(bucket.maxWaitMs, waitMs);
        bucket.maxRunMs = Math.max(bucket.maxRunMs, runMs);
        // Never retain task closures, arguments, results, error messages, or account/friend IDs.
        const rawName = String(task.name);
        const name = /^api:[a-zA-Z]+$/.test(rawName) ? rawName : rawName.split(':')[0].slice(0, 80);
        this.types.record(`${name}.waitMs`, waitMs, true);
        this.types.record(`${name}.runMs`, runMs, true);
        this.types.record(`${name}.${outcome}`);
        this.recent.push({ mono: now, at: Date.now(), name, priority: task.priority, outcome, waitMs, runMs });
        // Reserve ten slots for manual work so background scans cannot immediately hide it.
        const manual = this.recent.filter(item => item.priority === 'interactive').slice(-10);
        const other = this.recent.filter(item => item.priority !== 'interactive').slice(-10);
        this.recent = [...manual, ...other].sort((a, b) => a.mono - b.mono);
    }

    snapshot(queued: any[], running: any): any {
        const now = this.now();
        this.prune(now);
        const window = { windowMs: WINDOW_MS, bucketMs: BUCKET_MS, observedMs: Math.min(WINDOW_MS, Math.max(0, now - this.since)),
            submitted: 0, completed: 0, failed: 0, cancelled: 0, expired: 0, rejected: 0, coalesced: 0,
            peakQueued: queued.length, maxWaitMs: 0, maxRunMs: 0 };
        for (const bucket of this.buckets) {
            for (const key of ['submitted', 'completed', 'failed', 'cancelled', 'expired', 'rejected', 'coalesced']) window[key] += bucket[key];
            for (const key of ['peakQueued', 'maxWaitMs', 'maxRunMs']) window[key] = Math.max(window[key], bucket[key]);
        }
        for (const task of queued) window.maxWaitMs = Math.max(window.maxWaitMs, now - task.queuedMonoAt);
        if (running) {
            window.maxWaitMs = Math.max(window.maxWaitMs, running.startedMonoAt - running.queuedMonoAt);
            window.maxRunMs = Math.max(window.maxRunMs, now - running.startedMonoAt);
        }
        return { window, types: this.types.snapshot(), recent: this.recent.map(({ mono, ...item }) => ({ ...item, ageMs: Math.max(0, now - mono) })).reverse() };
    }
}

module.exports = { TaskDiagnostics };
