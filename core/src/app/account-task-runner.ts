import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

export {};

const { getAmbientRequestClass, runWithRequestClass, captureBuiltinTask, runWithSendContext } = require('../utils/request-context');
const { createExecutionScope, getExecutionScope, runWithExecutionScope } = require('../utils/execution-scope');
const { TaskDiagnostics } = require('./task-diagnostics');

type AccountTaskPriority = 'recovery' | 'interactive' | 'event' | 'scheduled' | 'maintenance';

interface AccountTaskOptions {
    priority?: AccountTaskPriority;
    dedupeKey?: string;
    requestClass?: 'critical' | 'foreground' | 'farm' | 'friend' | 'background';
    maxQueueWaitMs?: number;
    maxExecutionMs?: number;
    source?: string;
    signal?: AbortSignal;
    /** Read-only callers may share the in-flight read and cancel independently. */
    dedupeMode?: 'queued' | 'read';
    onStarted?: () => void;
    /** Wall-clock deadline (Date.now() ms) by which the task should start executing. */
    deadlineAt?: number;
    /** Estimated execution duration in ms used to protect urgent deadlines from slow aged tasks. */
    estimatedDurationMs?: number;
    /** Upper bound priority that aging may promote this task to (never 'recovery'). */
    maxAgedPriority?: AccountTaskPriority;
}

interface AccountTaskRunnerOptions {
    now?: () => number;
    agingIntervalMs?: number;
    slowTaskMs?: number;
    onSlowTask?: (info: { name: string; priority: string; runningMs: number; queued: number }) => void;
    maxPending?: number;
    maxSharedReadWaiters?: number;
    yieldEvery?: number;
    yieldBudgetMs?: number;
}

interface TaskReader {
    parentExecution: any;
    resolve: (value: any) => void;
    reject: (reason?: any) => void;
    removeAbort: () => void;
    queueTimer?: ReturnType<typeof setTimeout>;
    queueExpiresAt?: number;
    onStarted?: () => void;
    started?: boolean;
}

interface QueuedTask<T> {
    name: string;
    priority: AccountTaskPriority;
    dedupeKey: string;
    requestClass: string | null;
    builtinScope: (run: () => any) => any;
    queuedAt: number;
    queuedMonoAt: number;
    startedMonoAt?: number;
    sequence: number;
    run: () => Promise<T> | T;
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: any) => void;
    queueTimer?: ReturnType<typeof setTimeout>;
    queueExpiresAt?: number;
    parentExecution: any;
    maxExecutionMs: number;
    removeAbort?: () => void;
    source: string;
    deadlineMonoAt?: number;
    estimatedDurationMs: number;
    maxAgedRank: number;
    readers?: Set<TaskReader>;
    readController?: AbortController;
    signal?: AbortSignal;
}

/** Async resources retain only this identity, not task closures, promises or results. */
interface ExecutionToken { sequence: number }

const PRIORITY_RANK: Record<AccountTaskPriority, number> = {
    recovery: -1,
    interactive: 0,
    event: 1,
    scheduled: 2,
    maintenance: 3,
};

const DEFAULT_AGING_INTERVAL_MS = 30000;
/** 单个账号任务运行超过此时长时记录一次告警，便于定位卡住整个账号队列的任务。 */
const DEFAULT_SLOW_TASK_MS = 60000;
const MAX_NATIVE_DELAY_MS = 2147483647;
const DEFAULT_MAX_PENDING = 256;
const DEFAULT_QUEUE_WAIT_MS: Record<AccountTaskPriority, number> = {
    recovery: 120000, interactive: 15000, event: 30000, scheduled: 120000, maintenance: 300000,
};
const DEFAULT_ESTIMATED_DURATION_MS: Record<AccountTaskPriority, number> = {
    recovery: 800,
    interactive: 600,
    event: 600,
    scheduled: 800,
    maintenance: 1200,
};

function resolveEstimatedDurationMs(priority: AccountTaskPriority, value?: number): number {
    return Number.isFinite(value) && Number(value) > 0
        ? Math.min(30000, Math.max(50, Math.round(Number(value))))
        : DEFAULT_ESTIMATED_DURATION_MS[priority];
}

function resolveMaxAgedRank(priority: AccountTaskPriority, maxAgedPriority?: AccountTaskPriority): number {
    if (priority === 'recovery') return PRIORITY_RANK.recovery;
    const cap = maxAgedPriority && Object.hasOwn(PRIORITY_RANK, maxAgedPriority) && maxAgedPriority !== 'recovery'
        ? maxAgedPriority
        : 'interactive';
    return Math.min(PRIORITY_RANK[priority], Math.max(PRIORITY_RANK.interactive, PRIORITY_RANK[cap]));
}

function resolveDeadlineMonoAt(queuedAt: number, queuedMonoAt: number, deadlineAt?: number): number | undefined {
    return Number.isFinite(deadlineAt) ? queuedMonoAt + (Number(deadlineAt) - queuedAt) : undefined;
}

function boundedPositive(value: number | undefined, fallback: number, maximum = MAX_NATIVE_DELAY_MS): number {
    return Number.isFinite(value) && Number(value) > 0 ? Math.min(maximum, Math.max(1, Math.floor(Number(value)))) : fallback;
}

function queueWaitMs(options: AccountTaskOptions, priority: AccountTaskPriority): number {
    return Number.isFinite(options.maxQueueWaitMs) && Number(options.maxQueueWaitMs) >= 0
        ? Math.min(MAX_NATIVE_DELAY_MS, Number(options.maxQueueWaitMs)) : DEFAULT_QUEUE_WAIT_MS[priority];
}

function queueTimeoutError(): Error {
    return Object.assign(new Error('账号任务排队超时，任务未执行'), { code: 'ACCOUNT_TASK_QUEUE_TIMEOUT' });
}

function defaultSlowTaskReporter(info: { name: string; priority: string; runningMs: number; queued: number }): void {
    try {
        const { createModuleLogger } = require('../services/logger');
        createModuleLogger('account-task').warn(`账号任务运行过久: ${info.name}`, info);
    } catch {
        // 日志不可用时忽略
    }
}

class AccountTaskRunner {
    private readonly queue: QueuedTask<any>[] = [];
    private readonly queuedByDedupeKey = new Map<string, QueuedTask<any>>();
    private readonly executionContext = new AsyncLocalStorage<ExecutionToken>();
    private readonly now: () => number;
    private readonly agingIntervalMs: number;
    private activeTask: QueuedTask<any> | null = null;
    private sequence = 0;
    private drainScheduled = false;
    private closedReason = '';
    private readonly slowTaskMs: number;
    private readonly onSlowTask: (info: { name: string; priority: string; runningMs: number; queued: number }) => void;
    private activeExecution: any = null;
    private activeToken: ExecutionToken | null = null;
    private readonly maxPending: number;
    private readonly maxSharedReadWaiters: number;
    private readonly yieldEvery: number;
    private readonly yieldBudgetMs: number;
    private completedInSlice = 0;
    private stepsInSlice = 0;
    private sliceStartedAt = performance.now();
    private stepSliceStartedAt = performance.now();
    private readonly diagnostics: any;

    constructor(options: AccountTaskRunnerOptions = {}) {
        this.now = options.now || (() => performance.now());
        this.diagnostics = new TaskDiagnostics(this.now);
        this.agingIntervalMs = boundedPositive(options.agingIntervalMs, DEFAULT_AGING_INTERVAL_MS);
        this.slowTaskMs = boundedPositive(options.slowTaskMs, DEFAULT_SLOW_TASK_MS);
        this.onSlowTask = options.onSlowTask || defaultSlowTaskReporter;
        this.maxPending = boundedPositive(options.maxPending, DEFAULT_MAX_PENDING, 10000);
        this.maxSharedReadWaiters = boundedPositive(options.maxSharedReadWaiters, 256, 10000);
        this.yieldEvery = boundedPositive(options.yieldEvery, 32, 1000);
        this.yieldBudgetMs = boundedPositive(options.yieldBudgetMs, 5, 1000);
    }

    close(reason = '账号任务已停止'): number {
        this.closedReason = String(reason || '账号任务已停止');
        const error = Object.assign(new Error(this.closedReason), { code: 'ACCOUNT_OFFLINE' });
        this.activeExecution?.cancel(error);
        if (this.activeTask?.readers) {
            const task = this.activeTask;
            task.readController!.abort(error);
            task.reject(error);
            if (this.queuedByDedupeKey.get(task.dedupeKey) === task) this.queuedByDedupeKey.delete(task.dedupeKey);
        }
        return this.clearPending(this.closedReason);
    }

    open(): void {
        this.closedReason = '';
    }

    /** Event follow-ups own a queue slot and execution lifetime. The emitter must not await work queued behind itself. */
    enqueue<T>(name: string, run: () => Promise<T> | T, options: AccountTaskOptions = {}): Promise<T> {
        const blocked = getExecutionScope()?.check();
        if (blocked) return Promise.reject(blocked);
        return this.executionContext.run(null, () => runWithExecutionScope(null,
            () => runWithSendContext(null, () => this.submit(name, run, options))));
    }

    /** Detached tasks escape the caller's execution scope, send guard and ambient request class while staying serial in the account queue. */
    enqueueDetached<T>(name: string, run: () => Promise<T> | T, options: AccountTaskOptions = {}): Promise<T> {
        return this.executionContext.run(null, () => runWithExecutionScope(null,
            () => runWithSendContext(null, () => runWithRequestClass(options.requestClass ?? null, () => this.submit(name, run, options)))));
    }

    submit<T>(name: string, run: () => Promise<T> | T, options: AccountTaskOptions = {}): Promise<T> {
        const taskName = String(name || '').trim();
        if (!taskName) throw new Error('账号任务名称不能为空');
        if (typeof run !== 'function') throw new Error(`账号任务 ${taskName} 缺少执行函数`);
        if (this.closedReason) return Promise.reject(new Error(this.closedReason));
        const parentExecution = getExecutionScope();
        const blocked = parentExecution?.check();
        if (blocked) return Promise.reject(blocked);
        if (options.signal?.aborted) return Promise.reject(options.signal.reason);

        if (this.activeToken && this.executionContext.getStore() === this.activeToken) {
            const nestedRequestClass = options.requestClass || getAmbientRequestClass();
            return Promise.resolve().then(() => runWithRequestClass(
                nestedRequestClass,
                () => captureBuiltinTask(taskName, nestedRequestClass)(run),
            ));
        }

        const priority = Object.hasOwn(PRIORITY_RANK, options.priority || '') ? options.priority! : 'scheduled';
        const requestClass = options.requestClass
            || getAmbientRequestClass()
            || (priority === 'interactive' ? 'foreground' : null);
        const queuedAt = Date.now();
        const queuedMonoAt = this.now();
        const maxAgedRank = resolveMaxAgedRank(priority, options.maxAgedPriority);
        const estimatedDurationMs = resolveEstimatedDurationMs(priority, options.estimatedDurationMs);
        const deadlineMonoAt = resolveDeadlineMonoAt(queuedAt, queuedMonoAt, options.deadlineAt);
        const dedupeKey = String(options.dedupeKey || '').trim();
        const sharedRead = options.dedupeMode === 'read' && !!dedupeKey;
        if (dedupeKey) {
            const queued = this.queuedByDedupeKey.get(dedupeKey);
            if (queued && !!queued.readers === sharedRead) {
                this.diagnostics.count('coalesced');
                if (PRIORITY_RANK[priority] < PRIORITY_RANK[queued.priority]) {
                    queued.priority = priority;
                    queued.requestClass = requestClass;
                }
                if (maxAgedRank < queued.maxAgedRank) queued.maxAgedRank = maxAgedRank;
                if (estimatedDurationMs < queued.estimatedDurationMs) queued.estimatedDurationMs = estimatedDurationMs;
                if (deadlineMonoAt !== undefined) {
                    queued.deadlineMonoAt = queued.deadlineMonoAt === undefined
                        ? deadlineMonoAt
                        : Math.min(queued.deadlineMonoAt, deadlineMonoAt);
                }
                return sharedRead ? this.addReadWaiter<T>(queued, parentExecution, options) : queued.promise as Promise<T>;
            }
        }
        if (priority !== 'recovery' && this.queue.length >= this.maxPending) {
            this.diagnostics.count('rejected');
            return Promise.reject(Object.assign(new Error('账号待执行任务已达上限，请稍后重试'), {
                code: 'ACCOUNT_TASK_QUEUE_FULL', retryAt: Date.now() + 1000,
                source: String(options.source || priority), maxPending: this.maxPending,
            }));
        }

        let resolve!: (value: T | PromiseLike<T>) => void;
        let reject!: (reason?: any) => void;
        const promise = new Promise<T>((done, fail) => {
            resolve = done;
            reject = fail;
        });
        let recorded = false;
        // task 在下方构造，但 resolve/reject 的收尾回调会先于它被调用，这里用 let 前向声明。
        let task: QueuedTask<T>;
        const finish = (error?: any) => {
            if (recorded) return;
            recorded = true;
            this.diagnostics.finish(task, error);
        };
        const done = resolve;
        const fail = reject;
        resolve = value => { finish(); done(value); };
        reject = error => { finish(error || new Error('任务取消')); fail(error); };
        task = {
            name: taskName,
            priority,
            dedupeKey,
            requestClass,
            builtinScope: captureBuiltinTask(taskName, requestClass),
            queuedAt,
            queuedMonoAt,
            sequence: this.sequence++,
            run,
            promise,
            resolve,
            reject,
            parentExecution: sharedRead ? null : parentExecution,
            maxExecutionMs: boundedPositive(options.maxExecutionMs, 180000),
            source: String(options.source || priority).slice(0, 80),
            deadlineMonoAt,
            estimatedDurationMs,
            maxAgedRank,
            ...(sharedRead ? { readers: new Set<TaskReader>(), readController: new AbortController() } : {}),
        };
        let resultPromise = promise;
        if (sharedRead) {
            // A task owns its read; reader promises are settled directly so an
            // aborted reader leaves no retained .then closure on a slow request.
            promise.catch(() => {});
            task.resolve = value => {
                for (const reader of task.readers!) { reader.removeAbort(); reader.resolve(value); }
                task.readers!.clear();
                resolve(value);
            };
            task.reject = reason => {
                for (const reader of task.readers!) { reader.removeAbort(); reader.reject(reason); }
                task.readers!.clear();
                reject(reason);
            };
            task.parentExecution = this.sharedReadParent(task);
            resultPromise = this.addReadWaiter<T>(task, parentExecution, options);
        }

        this.queue.push(task);
        this.diagnostics.count('submitted', this.queue.length);
        if (!sharedRead && (parentExecution || options.signal)) {
            const onAbort = () => {
                const index = this.queue.indexOf(task);
                if (index < 0) return;
                this.queue.splice(index, 1);
                clearTimeout(task.queueTimer);
                task.removeAbort?.();
                if (task.dedupeKey && this.queuedByDedupeKey.get(task.dedupeKey) === task) this.queuedByDedupeKey.delete(task.dedupeKey);
                task.reject(options.signal?.aborted ? options.signal.reason : parentExecution?.signal.reason);
                this.scheduleDrain();
            };
            parentExecution?.signal.addEventListener('abort', onAbort, { once: true });
            options.signal?.addEventListener('abort', onAbort, { once: true });
            task.removeAbort = () => {
                parentExecution?.signal.removeEventListener('abort', onAbort);
                options.signal?.removeEventListener('abort', onAbort);
            };
            // Once running, the execution scope owns the external signal.
            task.signal = options.signal;
        }
        if (dedupeKey) this.queuedByDedupeKey.set(dedupeKey, task);
        if (!sharedRead) {
            const waitMs = queueWaitMs(options, priority);
            task.queueExpiresAt = task.queuedMonoAt + waitMs;
            task.queueTimer = setTimeout(() => {
                const index = this.queue.indexOf(task);
                if (index < 0) return;
                this.queue.splice(index, 1);
                this.rejectExpired(task);
                this.scheduleDrain();
            }, waitMs);
            task.queueTimer.unref?.();
        }
        this.scheduleDrain();
        return resultPromise;
    }

    async runStep<T>(name: string, run: () => Promise<T> | T): Promise<T> {
        const taskName = String(name || '').trim();
        if (!taskName) throw new Error('账号任务步骤名称不能为空');
        if (typeof run !== 'function') throw new Error(`账号任务步骤 ${taskName} 缺少执行函数`);
        if (++this.stepsInSlice >= this.yieldEvery || performance.now() - this.stepSliceStartedAt >= this.yieldBudgetMs) {
            // The caller still owns the account transaction across this yield.
            await new Promise<void>(resolve => setImmediate(resolve));
            this.stepsInSlice = 0;
            this.stepSliceStartedAt = performance.now();
        }
        const blocked = getExecutionScope()?.check();
        if (blocked) throw blocked;
        return run();
    }

    clearPending(reason = '账号任务已停止'): number {
        const pending = this.queue.splice(0);
        for (const task of pending) {
            clearTimeout(task.queueTimer);
            task.removeAbort?.();
            if (task.dedupeKey && this.queuedByDedupeKey.get(task.dedupeKey) === task) this.queuedByDedupeKey.delete(task.dedupeKey);
            task.reject(new Error(reason));
        }
        return pending.length;
    }

    /** 排队中的任务数；priority 指定时只统计该优先级。用于后台任务的准入判断。 */
    pendingCount(priority?: AccountTaskPriority): number {
        return priority ? this.queue.filter(task => task.priority === priority).length : this.queue.length;
    }

    getSnapshot(): any {
        const now = this.now();
        return {
            ...this.diagnostics.snapshot(this.queue, this.activeTask),
            closed: this.closedReason !== '',
            maxPending: this.maxPending,
            running: this.activeTask
                ? {
                    name: this.activeTask.name,
                    priority: this.activeTask.priority,
                    source: this.activeTask.source,
                    queuedAt: this.activeTask.queuedAt,
                    waitMs: Math.max(0, this.activeTask.startedMonoAt! - this.activeTask.queuedMonoAt),
                    execution: this.activeExecution?.snapshot(),
                }
                : null,
            queued: this.queue.map(task => ({
                name: task.name,
                priority: task.priority,
                source: task.source,
                queuedAt: task.queuedAt,
                waitMs: Math.max(0, now - task.queuedMonoAt),
                estimatedDurationMs: task.estimatedDurationMs,
                ...(task.deadlineMonoAt !== undefined ? { deadlineInMs: Math.round(task.deadlineMonoAt - now) } : {}),
            })),
        };
    }

    private scheduleDrain(): void {
        if (this.drainScheduled || this.activeTask) return;
        this.drainScheduled = true;
        const resume = () => {
            this.drainScheduled = false;
            void this.drain();
        };
        if (this.completedInSlice >= this.yieldEvery || performance.now() - this.sliceStartedAt >= this.yieldBudgetMs) {
            setImmediate(() => {
                this.completedInSlice = 0;
                this.sliceStartedAt = performance.now();
                resume();
            });
        } else queueMicrotask(resume);
    }

    private addReadWaiter<T>(task: QueuedTask<any>, parentExecution: any, options: AccountTaskOptions): Promise<T> {
        const signal = options.signal;
        if (task.readers!.size >= this.maxSharedReadWaiters) {
            return Promise.reject(Object.assign(new Error('共享读取等待者已达上限，请稍后重试'), {
                code: 'ACCOUNT_TASK_QUEUE_FULL', retryAt: Date.now() + 1000, source: task.source,
            }));
        }
        const blocked = parentExecution?.check();
        if (blocked || signal?.aborted) return Promise.reject(blocked || signal!.reason);
        return new Promise<T>((resolve, reject) => {
            const reader: TaskReader = { parentExecution, resolve, reject, removeAbort: () => {}, onStarted: options.onStarted };
            const onAbort = () => this.removeReadWaiter(task, reader,
                signal?.aborted ? signal.reason : parentExecution?.signal.reason);
            reader.removeAbort = () => {
                clearTimeout(reader.queueTimer);
                parentExecution?.signal.removeEventListener('abort', onAbort);
                signal?.removeEventListener('abort', onAbort);
            };
            task.readers!.add(reader);
            parentExecution?.signal.addEventListener('abort', onAbort, { once: true });
            signal?.addEventListener('abort', onAbort, { once: true });
            if (this.activeTask !== task) {
                const priority = Object.hasOwn(PRIORITY_RANK, options.priority || '') ? options.priority! : task.priority;
                const waitMs = queueWaitMs(options, priority);
                reader.queueExpiresAt = this.now() + waitMs;
                reader.queueTimer = setTimeout(() => this.removeReadWaiter(task, reader, queueTimeoutError()), waitMs);
                reader.queueTimer.unref?.();
            } else this.announceReadStarted(task, reader);
        });
    }

    private announceReadStarted(task: QueuedTask<any>, reader: TaskReader): void {
        if (reader.started) return;
        reader.started = true;
        try { reader.onStarted?.(); }
        catch (error) { this.removeReadWaiter(task, reader, error); }
        reader.onStarted = undefined;
    }

    private removeReadWaiter(task: QueuedTask<any>, reader: TaskReader, reason: any): void {
        if (!task.readers!.delete(reader)) return;
        reader.removeAbort();
        reader.reject(reason);
        if (task.readers!.size > 0) return;
        task.readController!.abort(reason);
        if (task.dedupeKey && this.queuedByDedupeKey.get(task.dedupeKey) === task) this.queuedByDedupeKey.delete(task.dedupeKey);
        const index = this.queue.indexOf(task);
        if (index >= 0) {
            this.queue.splice(index, 1);
            clearTimeout(task.queueTimer);
            task.reject(reason);
            this.scheduleDrain();
        }
    }

    private sharedReadParent(task: QueuedTask<any>): any {
        // Execution scopes may be inherited by detached async resources too.
        // Retain only reader/accounting state here, never the queued callback.
        const readers = task.readers!;
        const controller = task.readController!;
        const checkReaders = (rpc: boolean) => {
            for (const reader of readers) {
                const blocked = rpc ? reader.parentExecution?.checkRpc() : reader.parentExecution?.check();
                if (blocked) {
                    readers.delete(reader);
                    reader.removeAbort();
                    reader.reject(blocked);
                    if (readers.size === 0) controller.abort(blocked);
                }
            }
            return controller.signal.aborted ? controller.signal.reason : null;
        };
        return {
            signal: controller.signal, deadlineAt: Infinity,
            check: () => checkReaders(false), checkRpc: () => checkReaders(true),
            recordRpc: (service: string, method: string, receipt = new Set<object>()) => {
                const owners = new Set(Array.from(readers, reader => reader.parentExecution).filter(Boolean));
                for (const owner of owners) owner.recordRpc(service, method, receipt);
            },
        };
    }

    private findMostUrgentDeadlineTask(_now: number): QueuedTask<any> | null {
        let urgent: QueuedTask<any> | null = null;
        for (const task of this.queue) {
            if (task.deadlineMonoAt === undefined) continue;
            if (task.priority !== 'interactive' && task.priority !== 'event' && task.priority !== 'scheduled') continue;
            if (!urgent) {
                urgent = task;
                continue;
            }
            const taskHighTier = PRIORITY_RANK[task.priority] <= PRIORITY_RANK.event ? 0 : 1;
            const urgentHighTier = PRIORITY_RANK[urgent.priority] <= PRIORITY_RANK.event ? 0 : 1;
            if (taskHighTier !== urgentHighTier
                ? taskHighTier < urgentHighTier
                : (task.deadlineMonoAt < urgent.deadlineMonoAt!
                    || (task.deadlineMonoAt === urgent.deadlineMonoAt! && PRIORITY_RANK[task.priority] < PRIORITY_RANK[urgent.priority])
                    || (task.deadlineMonoAt === urgent.deadlineMonoAt! && PRIORITY_RANK[task.priority] === PRIORITY_RANK[urgent.priority] && task.sequence < urgent.sequence))) {
                urgent = task;
            }
        }
        return urgent;
    }

    private compareQueuedTasks(a: QueuedTask<any>, b: QueuedTask<any>, urgent: QueuedTask<any> | null, now: number): number {
        const aRecovery = a.priority === 'recovery' ? 0 : 1;
        const bRecovery = b.priority === 'recovery' ? 0 : 1;
        if (aRecovery !== bRecovery) return aRecovery - bRecovery;

        const aRank = this.getEffectiveRank(a, now);
        const bRank = this.getEffectiveRank(b, now);

        const starvesUrgent = (task: QueuedTask<any>, rank: number): number => {
            if (!urgent || task === urgent) return 0;
            if (PRIORITY_RANK[task.priority] <= PRIORITY_RANK[urgent.priority]) return 0;
            if (urgent.priority === 'scheduled' && rank < PRIORITY_RANK.scheduled) return 0;
            return now + task.estimatedDurationMs > urgent.deadlineMonoAt! ? 1 : 0;
        };
        const aStarves = starvesUrgent(a, aRank);
        const bStarves = starvesUrgent(b, bRank);
        if (aStarves !== bStarves) return aStarves - bStarves;

        if (aRank !== bRank) return aRank - bRank;

        const aDue = aRank <= PRIORITY_RANK.event && a.deadlineMonoAt !== undefined && now >= a.deadlineMonoAt ? 0 : 1;
        const bDue = bRank <= PRIORITY_RANK.event && b.deadlineMonoAt !== undefined && now >= b.deadlineMonoAt ? 0 : 1;
        if (aDue !== bDue) return aDue - bDue;
        if (aDue === 0 && a.deadlineMonoAt !== b.deadlineMonoAt) {
            return a.deadlineMonoAt! - b.deadlineMonoAt!;
        }
        return a.sequence - b.sequence;
    }

    private takeNext(): QueuedTask<any> | null {
        if (this.queue.length === 0) return null;
        const now = this.now();
        const urgent = this.findMostUrgentDeadlineTask(now);
        let selectedIndex = 0;
        for (let index = 1; index < this.queue.length; index++) {
            if (this.compareQueuedTasks(this.queue[index], this.queue[selectedIndex], urgent, now) < 0) {
                selectedIndex = index;
            }
        }
        return this.queue.splice(selectedIndex, 1)[0];
    }

    private getEffectiveRank(task: QueuedTask<any>, now: number): number {
        if (task.priority === 'recovery') return PRIORITY_RANK.recovery;
        const agingSteps = Math.floor(Math.max(0, now - task.queuedMonoAt) / this.agingIntervalMs);
        let rank = Math.max(task.maxAgedRank, PRIORITY_RANK[task.priority] - agingSteps);
        if (task.deadlineMonoAt !== undefined && now >= task.deadlineMonoAt
            && (task.priority === 'interactive' || task.priority === 'event')) {
            rank = Math.min(rank, PRIORITY_RANK.interactive);
        }
        return rank;
    }

    private rejectExpired(task: QueuedTask<any>): void {
        clearTimeout(task.queueTimer);
        task.removeAbort?.();
        if (task.dedupeKey && this.queuedByDedupeKey.get(task.dedupeKey) === task) this.queuedByDedupeKey.delete(task.dedupeKey);
        task.reject(queueTimeoutError());
    }

    private async drain(): Promise<void> {
        if (this.activeTask) return;
        const task = this.takeNext();
        if (!task) return;
        clearTimeout(task.queueTimer);
        task.removeAbort?.();
        if (task.readers) {
            for (const reader of task.readers) {
                clearTimeout(reader.queueTimer);
                if (reader.queueExpiresAt !== undefined && this.now() >= reader.queueExpiresAt) {
                    this.removeReadWaiter(task, reader, queueTimeoutError());
                }
                reader.queueExpiresAt = undefined;
            }
            if (task.readers.size === 0) {
                task.reject(task.readController!.signal.reason || queueTimeoutError());
                this.completedInSlice += 1;
                this.scheduleDrain();
                return;
            }
        }
        if (task.queueExpiresAt !== undefined && this.now() >= task.queueExpiresAt) {
            this.rejectExpired(task);
            this.completedInSlice += 1;
            this.scheduleDrain();
            return;
        }

        this.activeTask = task;
        task.startedMonoAt = this.now();
        const execution = createExecutionScope({ parent: task.parentExecution, signal: task.signal,
            timeoutMs: task.maxExecutionMs, info: { task: task.name, source: task.source } });
        this.activeExecution = execution;
        const token: ExecutionToken = { sequence: task.sequence };
        this.activeToken = token;
        this.stepsInSlice = 0;
        this.stepSliceStartedAt = performance.now();
        if (!task.readers && task.dedupeKey && this.queuedByDedupeKey.get(task.dedupeKey) === task) {
            this.queuedByDedupeKey.delete(task.dedupeKey);
        }

        const startedAt = this.now();
        const slowTimer = setTimeout(() => {
            if (this.activeTask !== task) return;
            try {
                this.onSlowTask({ name: task.name, priority: task.priority, runningMs: this.now() - startedAt, queued: this.queue.length, ...execution.snapshot() });
            } catch {
                // 诊断回调失败不能中断账号任务。
            }
        }, this.slowTaskMs);
        slowTimer.unref?.();
        try {
            let blocked = execution.check();
            if (blocked) throw blocked;
            if (task.readers) for (const reader of [...task.readers]) this.announceReadStarted(task, reader);
            blocked = execution.check();
            if (blocked) throw blocked;
            task.resolve(await runWithExecutionScope(execution, () => runWithRequestClass(
                task.requestClass, () => task.builtinScope(() => this.executionContext.run(token, task.run)),
            )));
        } catch (error) {
            task.reject(error);
        } finally {
            clearTimeout(slowTimer);
            execution.dispose();
            this.activeExecution = null;
            this.activeToken = null;
            this.activeTask = null;
            if (task.dedupeKey && this.queuedByDedupeKey.get(task.dedupeKey) === task) this.queuedByDedupeKey.delete(task.dedupeKey);
            this.completedInSlice += 1;
            this.scheduleDrain();
        }
    }
}

const accountTaskRunner = new AccountTaskRunner();

function submitAccountTask<T>(
    name: string,
    run: () => Promise<T> | T,
    options: AccountTaskOptions = {},
): Promise<T> {
    return accountTaskRunner.submit(name, run, options);
}

function enqueueAccountTask<T>(name: string, run: () => Promise<T> | T, options: AccountTaskOptions = {}): Promise<T> {
    return accountTaskRunner.enqueue(name, run, options);
}

function enqueueDetachedAccountTask<T>(name: string, run: () => Promise<T> | T, options: AccountTaskOptions = {}): Promise<T> {
    return accountTaskRunner.enqueueDetached(name, run, options);
}

function clearPendingAccountTasks(reason?: string): number {
    return accountTaskRunner.clearPending(reason);
}

function runAccountTaskStep<T>(name: string, run: () => Promise<T> | T): Promise<T> {
    return accountTaskRunner.runStep(name, run);
}

function closeAccountTaskQueue(reason?: string): number {
    return accountTaskRunner.close(reason);
}

function openAccountTaskQueue(): void {
    accountTaskRunner.open();
}

function getAccountTaskRunnerSnapshot(): any {
    return accountTaskRunner.getSnapshot();
}

function getPendingAccountTaskCount(priority?: AccountTaskPriority): number {
    return accountTaskRunner.pendingCount(priority);
}

module.exports = {
    AccountTaskRunner,
    clearPendingAccountTasks,
    closeAccountTaskQueue,
    enqueueAccountTask,
    enqueueDetachedAccountTask,
    getAccountTaskRunnerSnapshot,
    getPendingAccountTaskCount,
    openAccountTaskQueue,
    runAccountTaskStep,
    submitAccountTask,
};
