export {};

/** One bounded, read-only in-flight slot. Consumers own cancellation; the first
 * caller never owns the shared transport request. Do not use for write commands
 * or for authoritative checks immediately before a write. */
const { createExecutionScope, getExecutionScope, runWithExecutionScope } = require('./execution-scope');
const { getAmbientSendContext, runWithSendContext } = require('./request-context');

function readError(code: string, message: string): Error {
    return Object.assign(new Error(message), { code });
}

interface SharedReadOptions {
    timeoutMs?: number;
    maxReaders?: number;
    maxPending?: number;
}

interface ReaderOptions {
    signal?: AbortSignal;
    scope?: any;
}

function createSharedRead(options: SharedReadOptions = {}) {
    const maxReaders = Math.max(1, Math.min(1024, Number(options.maxReaders) || 128));
    const maxPending = Math.max(1, Math.min(16, Number(options.maxPending) || 4));
    const timeoutMs = Math.max(1, Math.min(120_000, Number(options.timeoutMs) || 30_000));
    let pending: any = null;
    const loads = new Set<any>();

    function leave(load: any, reader: any, error?: any, value?: any): void {
        if (reader.done) return;
        reader.done = true;
        load.readers.delete(reader);
        reader.scope?.signal.removeEventListener('abort', reader.onAbort);
        reader.signal?.removeEventListener('abort', reader.onAbort);
        reader.removeDispose?.();
        if (error) reader.reject(error);
        else reader.resolve(value);
        if (!load.settled && load.readers.size === 0) {
            if (pending === load) pending = null;
            load.execution.cancel(readError('READ_CANCELLED', '共享读取已没有有效读者'));
        }
    }

    function validReaders(load: any, service?: string, method?: string, checkBudget = false): any[] {
        const readers: any[] = [];
        for (const reader of [...load.readers]) {
            let blocked: any;
            try {
                blocked = reader.scope?.check();
                if (!blocked && reader.signal?.aborted) blocked = reader.signal.reason || readError('READ_CANCELLED', '读取已取消');
                if (!blocked && checkBudget) blocked = reader.scope?.checkRpc();
                if (!blocked && service !== undefined) blocked = reader.sendContext?.check(service, method);
            } catch (error) { blocked = error; }
            if (blocked) leave(load, reader, blocked);
            else readers.push(reader);
        }
        return readers;
    }

    function get<T>(loader: () => Promise<T>, readerOptions: ReaderOptions = {}): Promise<T> {
        const scope = readerOptions.scope === undefined ? getExecutionScope() : readerOptions.scope;
        const blocked = scope?.check() || (readerOptions.signal?.aborted
            ? readerOptions.signal.reason || readError('READ_CANCELLED', '读取已取消') : null);
        if (blocked) return Promise.reject(blocked);
        if (pending && pending.readers.size >= maxReaders) {
            return Promise.reject(readError('SHARED_READ_BUSY', '共享读取等待人数已达上限'));
        }
        let load = pending;
        const start = !load;
        if (!load) {
            if (loads.size >= maxPending) return Promise.reject(readError('SHARED_READ_BUSY', '共享读取仍在安全收尾，请稍后重试'));
            const execution = createExecutionScope({ parent: null, timeoutMs });
            load = { execution, readers: new Set<any>(), settled: false };
            pending = load;
            loads.add(load);
        }
        const result = new Promise<T>((resolve, reject) => {
            const reader: any = { scope, signal: readerOptions.signal, sendContext: getAmbientSendContext(), resolve, reject, done: false };
            reader.onAbort = () => leave(load, reader, reader.signal?.aborted
                ? reader.signal.reason || readError('READ_CANCELLED', '读取已取消')
                : reader.scope?.signal.reason || readError('READ_CANCELLED', '读取已取消'));
            load.readers.add(reader);
            scope?.signal.addEventListener('abort', reader.onAbort, { once: true });
            reader.signal?.addEventListener('abort', reader.onAbort, { once: true });
            reader.removeDispose = scope?.onDispose?.(() => leave(load, reader, readError('EXECUTION_FINISHED', '读取所属任务已结束')));
        });
        if (start) {
            const execution = load.execution;
            if (execution.signal.aborted && load.readers.size === 0) {
                load.settled = true;
                if (pending === load) pending = null;
                loads.delete(load);
                execution.dispose();
                return result;
            }
            const ensureReaders = (checkBudget = false): Error | null => {
                const ownError = execution.check();
                if (ownError) return ownError;
                return validReaders(load, undefined, undefined, checkBudget).length > 0
                    ? null : execution.check() || readError('READ_CANCELLED', '共享读取已没有有效读者');
            };
            const sharedExecution = {
                ...execution,
                check: () => ensureReaders(),
                checkRpc: () => ensureReaders(true) || execution.checkRpc(),
                recordRpc: (service: string, method: string, receipt = new Set<object>()) => {
                    execution.recordRpc(service, method, receipt);
                    // Each live consumer accounts for the physical request, while
                    // a shared ancestor counts it only once.
                    const scopes = new Set<any>();
                    for (const reader of validReaders(load, service, method)) if (reader.scope) scopes.add(reader.scope);
                    for (const consumer of scopes) consumer.recordRpc(service, method, receipt);
                },
            };
            const sharedSendContext = {
                check: (service: string, method: string) => {
                    const ownError = ensureReaders();
                    if (ownError) return ownError;
                    return validReaders(load, service, method).length > 0
                        ? null : execution.check() || readError('READ_CANCELLED', '共享读取已没有允许发送的读者');
                },
                onSent: (service: string, method: string) => {
                    const contexts = new Set<any>();
                    for (const reader of validReaders(load, service, method)) if (reader.sendContext) contexts.add(reader.sendContext);
                    for (const context of contexts) context.onSent(service, method);
                },
            };
            const onSharedAbort = () => {
                if (pending === load) pending = null;
                for (const reader of [...load.readers]) leave(load, reader, execution.signal.reason);
            };
            execution.signal.addEventListener('abort', onSharedAbort, { once: true });
            let request: Promise<T>;
            try {
                request = Promise.resolve(runWithExecutionScope(sharedExecution, () => runWithSendContext(sharedSendContext, loader)));
            } catch (error) { request = Promise.reject(error); }
            // Always observe the transport promise, including after every reader
            // has left. A non-cooperative loader remains in the bounded settling set.
            request.then(value => {
                const readers = validReaders(load);
                load.settled = true;
                if (pending === load) pending = null;
                for (const reader of readers) leave(load, reader, undefined, value);
            }, error => {
                load.settled = true;
                if (pending === load) pending = null;
                for (const reader of [...load.readers]) leave(load, reader, error);
            }).finally(() => {
                load.settled = true;
                if (pending === load) pending = null;
                loads.delete(load);
                execution.signal.removeEventListener('abort', onSharedAbort);
                execution.dispose();
            }).catch(() => {});
        }
        return result;
    }

    /** Detach the old version immediately. A state invalidation may let existing
     * readers finish; ending an account session also aborts their transport. */
    function invalidate(reason: any = readError('READ_INVALIDATED', '读取所属会话已结束'), cancelPending = true): void {
        pending = null;
        if (cancelPending) for (const load of [...loads]) load.execution.cancel(reason);
    }

    function stats(): { pending: number; readers: number; settling: number } {
        return { pending: pending ? 1 : 0, readers: [...loads].reduce((sum, load) => sum + load.readers.size, 0), settling: loads.size };
    }

    return { get, invalidate, stats };
}

module.exports = { createSharedRead };
