export {};
const { AsyncLocalStorage } = require('node:async_hooks');
const { performance } = require('node:perf_hooks');
const executionStorage = new AsyncLocalStorage();

function executionError(code: string, message: string): Error {
    return Object.assign(new Error(message), { code });
}

function getExecutionScope(): any { return executionStorage.getStore() || null; }
function runWithExecutionScope<T>(scope: any, run: () => T): T { return executionStorage.run(scope, run); }

interface ExecutionOptions {
    validate?: () => Error | null;
    timeoutMs?: number;
    deadlineAt?: number;
    signal?: AbortSignal;
    parent?: any;
    rpcBudget?: number;
    info?: Record<string, unknown>;
    clock?: () => number;
}

/** Cooperative cancellation: never release an account/transaction lock by racing its promise. */
function createExecutionScope(options: ExecutionOptions = {}) {
    const parent = options.parent === undefined ? getExecutionScope() : options.parent;
    const controller = new AbortController();
    const startedAt = Date.now();
    const clock = options.clock || (() => performance.now());
    const startedMono = clock();
    const duration = Math.min(options.deadlineAt === undefined ? options.timeoutMs ?? Infinity : Math.max(0, options.deadlineAt - startedAt),
        parent?.remainingMs?.() ?? (parent?.deadlineAt === undefined ? Infinity : Math.max(0, parent.deadlineAt - startedAt)));
    const deadlineAt = startedAt + duration;
    const remainingMs = () => Math.max(0, duration - (clock() - startedMono));
    const disposers = new Set<() => void>();
    const rpcBudget = options.rpcBudget ?? 300;
    const methods = new Map<string, number>();
    const rpcKinds = { read: 0, write: 0, protocol: 0, other: 0 };
    const identity = {};
    let rpcCount = 0;
    let disposed = false;
    let timer: any;
    const cancel = (reason: any = executionError('EXECUTION_CANCELLED', '任务已取消，未发送后续请求')) => {
        if (!controller.signal.aborted) controller.abort(reason instanceof Error ? reason : executionError('EXECUTION_CANCELLED', String(reason)));
    };
    const onParentAbort = () => cancel(parent.signal.reason);
    const onExternalAbort = () => cancel(options.signal.reason);
    const check = (): Error | null => {
        if (controller.signal.aborted) return controller.signal.reason;
        if (disposed) return executionError('EXECUTION_FINISHED', '任务已结束，未发送后续请求');
        const invalid = options.validate?.();
        if (invalid) { cancel(invalid); return invalid; }
        const inherited = parent?.check();
        if (inherited) { cancel(inherited); return inherited; }
        if (remainingMs() <= 0) {
            cancel(executionError('EXECUTION_TIMEOUT', '任务超过执行截止时间，已停止后续请求'));
            return controller.signal.reason;
        }
        return null;
    };
    const checkRpc = (): Error | null => {
        const blocked = check() || parent?.checkRpc();
        if (blocked) return blocked;
        if (rpcCount >= rpcBudget) {
            cancel(executionError('RPC_BUDGET', '任务达到请求数量上限，已停止后续请求'));
            return controller.signal.reason;
        }
        return null;
    };
    if (parent?.signal.aborted) onParentAbort();
    else parent?.signal.addEventListener('abort', onParentAbort, { once: true });
    if (options.signal?.aborted) onExternalAbort();
    else options.signal?.addEventListener('abort', onExternalAbort, { once: true });
    const armDeadline = () => {
        if (disposed || controller.signal.aborted || !Number.isFinite(duration)) return;
        timer = setTimeout(() => {
            if (remainingMs() <= 0) cancel(executionError('EXECUTION_TIMEOUT', '任务超过执行截止时间，已停止后续请求'));
            else armDeadline();
        }, Math.min(2147483647, remainingMs()));
        timer.unref?.();
    };
    armDeadline();
    return {
        signal: controller.signal, deadlineAt, remainingMs, cancel, check, checkRpc,
        onDispose: (listener: () => void) => {
            if (disposed) listener();
            else disposers.add(listener);
            return () => disposers.delete(listener);
        },
        recordRpc: (service: string, method: string, receipt = new Set<object>()) => {
            if (receipt.has(identity)) return;
            receipt.add(identity);
            rpcCount++;
            // Classify only known method families; unfamiliar actions remain "other".
            if (['Heartbeat', 'AntiData', 'Login'].includes(method)) rpcKinds.protocol++;
            else if (/^(?:Get|List|Query|Read|Sync|Check|Peek)|^Bag$/.test(method)) rpcKinds.read++;
            else if (/^(?:Harvest|Plant|Water|Weed|Disinsect|Sell|Buy|Purchase|Use|Open|Claim|Receive|Upgrade|Feed|Hire|Interact|Produce|Advertise|Exchange)/.test(method)) rpcKinds.write++;
            else rpcKinds.other++;
            const key = `${service}.${method}`;
            if (methods.has(key) || methods.size < 32) methods.set(key, (methods.get(key) || 0) + 1);
            parent?.recordRpc(service, method, receipt);
        },
        snapshot: () => ({ ...options.info, startedAt, elapsedMs: Math.max(0, clock() - startedMono),
            deadlineAt: Number.isFinite(deadlineAt) ? deadlineAt : null,
            rpcCount, rpcBudget, rpcKinds: { ...rpcKinds }, methods: Object.fromEntries(methods),
            cancelled: controller.signal.aborted, cancelReason: controller.signal.reason?.code || null }),
        dispose: () => {
            if (disposed) return;
            disposed = true;
            clearTimeout(timer);
            parent?.signal.removeEventListener('abort', onParentAbort);
            options.signal?.removeEventListener('abort', onExternalAbort);
            for (const listener of disposers) { try { listener(); } catch {} }
            disposers.clear();
        },
    };
}

function executionSleep(ms: number): Promise<void> {
    const scope = getExecutionScope();
    const blocked = scope?.check();
    if (blocked) return Promise.reject(blocked);
    return new Promise((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout>;
        const onAbort = () => { clearTimeout(timer); reject(scope.signal.reason); };
        timer = setTimeout(() => { scope?.signal.removeEventListener('abort', onAbort); resolve(); }, Math.max(0, ms));
        scope?.signal.addEventListener('abort', onAbort, { once: true });
    });
}

module.exports = { createExecutionScope, getExecutionScope, runWithExecutionScope, executionSleep };
