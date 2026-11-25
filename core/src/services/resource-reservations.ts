export {};

/** One account's native and plugin consumers share pending resource holds. */
const fs = require('node:fs');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const { createHash, randomUUID } = require('node:crypto');
const { getDataDir } = require('../config/runtime-paths');
const { writeJsonFileAtomic } = require('./json-db');
const { getAmbientSendContext, runWithSendContext } = require('../utils/request-context');
const { isWriteRpc } = require('../session/write-classifier');
const { receiptsProveRejection, TERMINAL_RECEIPT_STATUSES } = require('../session/receipt-reconciler');

interface Cost { resourceKey: string; amount: string }
const pendingStatuses = new Set(['prepared', 'sent', 'unknown']);

function failure(code: string, message: string): Error {
    return Object.assign(new Error(message), { code });
}

function quantity(value: unknown): bigint {
    if ((typeof value === 'number' && !Number.isSafeInteger(value)) || !/^(?:0|[1-9]\d{0,30})$/.test(String(value))) throw failure('RESOURCE_STATE_UNAVAILABLE', '资源数量无效，已停止消耗');
    return BigInt(String(value));
}

function journalPath(dataDir: string, uuid: string): string {
    return path.join(dataDir, 'resource-reservations', `${createHash('sha256').update(uuid).digest('hex')}.json`);
}

function readRecords(file: string): any[] {
    if (!fs.existsSync(file)) return [];
    try {
        const value = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!Array.isArray(value?.records)) throw new Error('Invalid records');
        for (const record of value.records) {
            if (!record || !record.operationId || !Array.isArray(record.costs)) throw new Error('Invalid record');
            for (const cost of record.costs) {
                if (!/^item:\d+$/.test(cost.resourceKey)) throw new Error('Invalid resource');
                quantity(cost.amount);
            }
        }
        return value.records;
    } catch {
        throw failure('RESOURCE_STATE_UNAVAILABLE', '消费记录无法读取，已停止消耗，请检查数据文件');
    }
}

function createResourceReservations(dataDir: string, uuid: string) {
    const file = journalPath(dataDir, uuid);
    const context = new AsyncLocalStorage();
    let tail = Promise.resolve();
    const active = new Set<string>();

    function enqueue<T>(run: () => Promise<T>): Promise<T> {
        const next = tail.then(() => context.run(true, run));
        tail = next.then(() => {}, () => {});
        return next;
    }

    function withLock<T>(run: () => Promise<T>): Promise<T> {
        return context.getStore() ? run() : enqueue(run);
    }

    function listNative(): any[] { return uuid ? readRecords(file) : []; }
    function listPending(): any[] {
        const records = listNative().filter(record => pendingStatuses.has(record.status));
        if (!uuid) return records;
        const legacy = require('./mystery-purchase-state').forAccount(dataDir, uuid).listUnknown()
            .filter((entry: any) => !records.some(record => record.target === `mystery:${entry.key}`))
            .map((entry: any) => ({ operationId: `mystery-legacy:${entry.key}`, target: `mystery:${entry.key}`, status: 'unknown',
                label: '神秘商人（历史交易）', message: '旧记录未保存消费金额，请在游戏中核对后解除资源保护', createdAt: entry.record.updatedAt,
                costs: [], legacy: true, metadata: { mysteryVisit: entry.shop } }));
        return [...records, ...legacy];
    }
    function save(records: any[]): void {
        if (!uuid) return;
        const settled = records.filter(record => !pendingStatuses.has(record.status)).slice(-100);
        writeJsonFileAtomic(file, { records: [...settled, ...records.filter(record => pendingStatuses.has(record.status))] });
    }
    function pending(nativeOnly = false): any[] {
        const send = getAmbientSendContext();
        const external = nativeOnly ? [] : [
            ...(uuid ? readRecords(path.join(dataDir, 'plugins', 'ledger.json')).filter(record => record.accountUuid === uuid) : []),
            ...(send?.spendingReservations || []),
        ];
        const unique = new Map([...external, ...listPending()].map(record => [record.operationId, record]));
        return [...unique.values()].filter(record => pendingStatuses.has(record.status) && record.operationId !== send?.spendingOperationId);
    }
    function reserved(resourceKey: string, nativeOnly = false): string {
        const records = pending(nativeOnly);
        if (records.some(record => record.legacy)) throw failure('PENDING_CONFIRMATION', '历史神秘商人交易金额未知，请先在插件运行状态中核对');
        return records.flatMap(record => record.costs).filter(cost => cost.resourceKey === resourceKey)
            .reduce((total, cost) => total + quantity(cost.amount), 0n).toString();
    }
    function assertAvailable(costs: Cost[], balances: any[], minReserve: Record<string, string> = {}): void {
        const keys = new Set([...costs.map(cost => cost.resourceKey), ...Object.keys(minReserve)]);
        for (const key of keys) {
            const balance = balances.find(row => row.resourceKey === key);
            if (!balance || balance.state !== 'known' || balance.total === null) throw failure('BALANCE_UNKNOWN', `${key} 余额未知，未执行消耗`);
            const available = quantity(balance.total) - quantity(balance.locked || '0') - quantity(reserved(key));
            const cost = costs.filter(row => row.resourceKey === key).reduce((sum, row) => sum + quantity(row.amount), 0n);
            if (available < cost + quantity(minReserve[key] || '0')) {
                throw failure('RESERVE_PROTECTED', `${key} 扣除未决交易预留后余额不足，或将低于最低保留量`);
            }
        }
    }

    async function spend<T>(plan: { target: string; label: string; costs: Cost[]; balances: any[]; metadata?: any }, run: () => Promise<T>): Promise<T> {
        return withLock(async () => {
            if (pending().some(record => record.target === plan.target)) throw failure('PENDING_CONFIRMATION', '同类交易结果未知，请先在插件运行状态中核对');
            assertAvailable(plan.costs, plan.balances, getAmbientSendContext()?.spendingMinReserve);
            // Plugin operations already have a durable record in the main process.
            const parent = getAmbientSendContext();
            if (parent?.spendingOperationId || !uuid) return run();
            const record = { operationId: randomUUID(), accountUuid: uuid, target: plan.target, label: plan.label,
                costs: plan.costs, metadata: plan.metadata, authorizedRequestIds: [] as string[],
                status: 'unknown', createdAt: Date.now(), updatedAt: Date.now(), message: '交易已提交，等待核对' };
            save([...listNative(), record]);
            active.add(record.operationId);
            let sent = 0;
            let writeAttempts = 0;
            const requestIds: string[] = [];
            let first: { service: string; method: string } | undefined;
            const settle = (status: string, message: string) => save(listNative().map(row => row.operationId === record.operationId
                ? { ...row, status, message, updatedAt: Date.now() } : row));
            try {
                const result = await runWithSendContext({ ...parent,
                    nativeOperationId: record.operationId,
                    check: (service: string, method: string) => parent?.check(service, method) || null,
                    onBeforeDispatch: (service: string, method: string) => {
                        if (isWriteRpc(service, method)) writeAttempts++;
                        parent?.onBeforeDispatch?.(service, method);
                    },
                    onPrepareApproved: async (req: any) => {
                        if (req.operationId === record.operationId) {
                            record.authorizedRequestIds.push(req.requestId);
                            save(listNative().map(row => row.operationId === record.operationId ? { ...row, authorizedRequestIds: record.authorizedRequestIds } : row));
                        }
                        await parent?.onPrepareApproved?.(req);
                    },
                    onSent: (service: string, method: string) => {
                        if (isWriteRpc(service, method)) {
                            sent++;
                            first ??= { service, method };
                        }
                        parent?.onSent(service, method);
                    },
                    onReceiptSettled: (requestId: string) => {
                        if (requestId) requestIds.push(requestId);
                        parent?.onReceiptSettled?.(requestId);
                    },
                }, run);
                settle('confirmed', '已确认生效');
                if (requestIds.length > 0) {
                    void require('../utils/network').ackSessionResults?.(requestIds)?.catch?.(() => {});
                }
                return result;
            } catch (error: any) {
                const singleWriteGatewayRejected = writeAttempts <= 1 && sent <= 1 && error?.name === 'GatewayError'
                    && (!first || (error.serviceName === first.service && error.methodName === first.method));
                const definitelyUnsent = sent === 0 && (writeAttempts === 0 || (writeAttempts === 1 && error?.guaranteedUnsent === true));
                const rejected = definitelyUnsent || (writeAttempts <= 1 && error?.code === 'PURCHASE_REJECTED') || singleWriteGatewayRejected;
                settle(rejected ? 'rejected' : 'unknown', String(error?.message || error).slice(0, 300));
                if (requestIds.length > 0) {
                    void require('../utils/network').ackSessionResults?.(requestIds)?.catch?.(() => {});
                }
                throw error;
            } finally { active.delete(record.operationId); }
        });
    }

    function reconcileReceipts(receipts: any[]): Promise<{ reconciledCount: number; ackIds: string[] }> {
        // A late receipt can inherit the spend's context. Wait for its ledger write to finish.
        return enqueue(async () => {
            if (!uuid || !Array.isArray(receipts) || receipts.length === 0) {
                return { reconciledCount: 0, ackIds: [] };
            }
            const byOp = new Map<string, any[]>();
            for (const receipt of receipts) {
                if (!receipt?.operationId) continue;
                const list = byOp.get(receipt.operationId) || [];
                list.push(receipt);
                byOp.set(receipt.operationId, list);
            }
            const records = listNative();
            let changed = false;
            let reconciledCount = 0;
            const ackIds: string[] = [];
            const nextRecords = records.map((record: any) => {
                const group = byOp.get(record.operationId);
                if (!group || active.has(record.operationId)) return record;
                const allTerminal = group.every(item => TERMINAL_RECEIPT_STATUSES.has(item.status));
                if (!allTerminal) return record;
                if (!pendingStatuses.has(record.status)) {
                    for (const item of group) ackIds.push(item.requestId);
                    return record;
                }
                let nextRecord = record;
                if (receiptsProveRejection(record.authorizedRequestIds, group)) {
                    if (record.metadata?.mysteryVisit) {
                        require('./mystery-purchase-state').forAccount(dataDir, uuid).clear(record.metadata.mysteryVisit);
                    }
                    nextRecord = { ...record, status: 'rejected', resolvedBy: 'reconciler', updatedAt: Date.now(), message: '会话宿主回执确认未发送或被网关拒绝' };
                    changed = true;
                    reconciledCount += 1;
                }
                for (const item of group) ackIds.push(item.requestId);
                return nextRecord;
            });
            if (changed) save(nextRecords);
            return { reconciledCount, ackIds };
        });
    }

    function resolve(operationId: string, resolution: string): any {
        const records = listNative();
        const record = records.find(row => row.operationId === operationId) || listPending().find(row => row.operationId === operationId && row.legacy);
        if (!record) throw failure('NOT_FOUND', '交易记录不存在');
        if (active.has(operationId)) throw failure('OPERATION_IN_PROGRESS', '交易仍在执行，请稍后核对');
        if (record.status !== 'unknown' || !['confirmed', 'rejected'].includes(resolution)) throw failure('INVALID_ARGUMENT', '只能核对结果未知的交易');
        if (record.metadata?.mysteryVisit) {
            const mystery = require('./mystery-purchase-state').forAccount(dataDir, uuid);
            if (resolution === 'rejected') mystery.clear(record.metadata.mysteryVisit);
            else mystery.set(record.metadata.mysteryVisit, 'confirmed');
        }
        Object.assign(record, { status: resolution, resolvedBy: 'user', updatedAt: Date.now(), message: resolution === 'confirmed' ? '用户核对：已生效' : '用户核对：未生效' });
        save(records);
        return record;
    }
    return { withLock, pending, reserved, assertAvailable, spend, listNative, listPending, resolve, reconcileReceipts };
}

let current: ReturnType<typeof createResourceReservations> | undefined;
function forCurrentAccount(): ReturnType<typeof createResourceReservations> {
    return current ??= createResourceReservations(getDataDir(), process.env.FARM_ACCOUNT_UUID || '');
}

module.exports = { createResourceReservations, forCurrentAccount };
