export {};

// Fixed histogram bounds: percentiles are upper bounds, not exact samples.
const LIMITS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2000, 5000, 10000, 20000, 30000, 60000, 120000, 300000, 600000, Infinity];
const WINDOW_MS = 600000;
const BUCKET_MS = 30000;

class WindowMetrics {
    private buckets: any[] = [];
    constructor(private readonly now: () => number, private readonly maxKeys = 128) {}

    record(key: string, value = 1, distribution = false): void {
        const now = this.now();
        this.prune(now);
        const at = Math.floor(now / BUCKET_MS) * BUCKET_MS;
        let bucket = this.buckets.at(-1);
        if (!bucket || bucket.at !== at) {
            bucket = { at, metrics: new Map() };
            this.buckets.push(bucket);
        }
        if (!bucket.metrics.has(key) && bucket.metrics.size >= this.maxKeys) key = 'overflow';
        let metric = bucket.metrics.get(key);
        if (!metric) {
            metric = { count: 0, sum: 0, max: 0, histogram: distribution ? Array(LIMITS.length).fill(0) : null };
            bucket.metrics.set(key, metric);
        }
        metric.count++;
        metric.sum += value;
        metric.max = Math.max(metric.max, value);
        if (metric.histogram) metric.histogram[LIMITS.findIndex(limit => value <= limit)]++;
    }

    private prune(now: number): void {
        while (this.buckets.length && this.buckets[0].at + BUCKET_MS <= now - WINDOW_MS) this.buckets.shift();
    }

    snapshot(): any {
        this.prune(this.now());
        const merged = new Map<string, any>();
        for (const bucket of this.buckets) for (const [key, metric] of bucket.metrics) {
            let result = merged.get(key);
            if (!result) {
                result = { count: 0, sum: 0, max: 0, histogram: metric.histogram ? Array(LIMITS.length).fill(0) : null };
                merged.set(key, result);
            }
            result.count += metric.count;
            result.sum += metric.sum;
            result.max = Math.max(result.max, metric.max);
            if (result.histogram && metric.histogram) metric.histogram.forEach((n: number, index: number) => result.histogram[index] += n);
        }
        const metrics: any = {};
        for (const [key, { histogram, ...metric }] of merged) {
            const percentile = (fraction: number) => {
                let count = 0;
                const index = histogram.findIndex((n: number) => (count += n) >= Math.ceil(metric.count * fraction));
                return Number.isFinite(LIMITS[index]) ? LIMITS[index] : metric.max;
            };
            metrics[key] = { ...metric, ...(histogram ? { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) } : {}) };
        }
        return { windowMs: WINDOW_MS, bucketMs: BUCKET_MS, percentileMethod: 'fixed_bucket_upper_bound', metrics };
    }
}

module.exports = { WindowMetrics };
