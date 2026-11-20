# 日志空间拆分与配额

本文说明运行日志如何按「牧场 / 农场」两个空间拆分、各自的内存池上限，以及前端每个账号能看到多少条。

## 为什么要拆

改造前，农场日志与牧场日志混存在同一个内存池 `globalLogs`（上限 1000 条），读取时的逻辑是「先对全量池做过滤，再截取末尾 N 条」。

这带来两个问题：

1. **互相挤占**。牧场自动化日志产生频繁，牧场日志刷屏会把农场日志挤出池，导致农场侧看不到自己最近的日志。
2. **上限写死且重复**。1000 这个上限在两个写入点各写了一遍（`runtime-state.ts` 与 `worker-manager.ts`），改一处容易漏另一处。

拆分后，牧场日志与农场日志各用一个独立内存池，各自计数、各自截断，互不影响。

## 空间判定

一条日志属于哪个空间，由 `meta.module` 决定。判定顺序（服务端 `core/src/utils/utils.ts` 的 `resolveLogSpace` 与前端 `web/src/utils/log-space.ts` 的 `resolveEntrySpace` **保持完全一致**）：

1. `meta.module === 'ranch'` → 牧场
2. `meta.event` 以 `ranch_` 开头 → 牧场
3. `tag === '牧场'` → 牧场
4. 其余（农场 / 好友 / 仓库 / 任务 / 系统）→ 农场

牧场侧的调用点都显式带 `{ module: 'ranch' }`；`logWarn('牧场', ...)` 这类写法由 `inferModuleFromTag` 兜底转成 `ranch`，因此不会出现判不准的日志。

## 内存池

| 池 | 内容 | 上限 |
| --- | --- | --- |
| `logPools.ranch` | 牧场日志 | 2000 条 |
| `logPools.farm` | 全部非牧场日志 | 2000 条 |

两个数组物理独立，各自按 `LOG_POOL_LIMIT` 截断（超出时丢弃最旧的一条）。

### 唯一写入口

所有运行日志都必须经过 `runtime-state.ts` 的 `appendLog(entry)`：

```ts
function appendLog(entry: LogEntry): LogEntry {
    const space = resolveLogSpace(entry);
    entry.space = space;
    const pool = logPools[space] || logPools.farm;
    pool.push(entry);
    if (pool.length > LOG_POOL_LIMIT) pool.shift();
    return entry;
}
```

`worker-manager` 注入的是这个**函数**而不是数组引用，从机制上杜绝了绕过封顶的可能。`entry.space` 也会随 WebSocket 负载一起下发，前端据此分流。

## 查询接口

`GET /api/logs` 新增 `space` 查询参数：

| 取值 | 含义 |
| --- | --- |
| `space=ranch` | 只取牧场池 |
| `space=farm` | 只取农场池 |
| 不传 / 非法值 | 两池合并（按时间升序），等价于改造前的全量语义 |

其余参数（`limit`、`tag`、`module`、`event`、`keyword`、`isWarn`、`timeFrom`、`timeTo`）保持不变。空间过滤在「选哪个池」这一步完成，`filterLogs` 仍是纯字段过滤函数。

**单账号可见条数**：服务端查询默认 `limit=100`，取该账号在**对应空间**内的最新 100 条。因为池已按空间隔离，牧场日志不会再挤掉农场日志的可见名额。

## 前端

前端状态按空间拆成两个缓冲（`web/src/stores/status.ts`）：

- `farmLogs` —— 农场空间，各保留最新 100 条
- `ranchLogs` —— 牧场空间，各保留最新 100 条

面板对应关系：

| 面板 | 组件 | 数据源 |
| --- | --- | --- |
| 农场概览 | `web/src/views/Dashboard.vue` | `farmLogs` |
| 牧场概览 | `web/src/components/RunLogCard.vue` | `ranchLogs` |

牧场面板的模块筛选器只保留「牧场」，事件列表只保留 `ranch_*` 事件；农场面板保留原有的全部模块与事件。

### 实时推送

`logs:snapshot` 事件**按空间推两次**（事件名不变，负载增加 `space` 字段），前端按 `space` 分别替换对应缓冲。合并推一份的话总量只有 100 条，「每空间 100 条」无法成立。

`log:new` 事件不需要新增字段——服务端 `appendLog` 已在条目上打了 `space` 标记，随负载天然携带。

## 清理日志

`DELETE /api/logs` 默认清掉该账号在**两个空间**的全部运行日志，与改造前的「清空这个账号的运行日志」语义一致。清空后按空间重推快照（牧场 / 农场 × 指定账号 / 聚合视图，共 4 次）。

## 相关文件

| 文件 | 职责 |
| --- | --- |
| `core/src/utils/utils.ts` | 空间判定：`resolveLogSpace`、`normalizeLogSpace` |
| `core/src/runtime/runtime-state.ts` | 双池定义、`LOG_POOL_LIMIT`、`appendLog` |
| `core/src/runtime/worker-manager.ts` | worker 日志统一走 `appendLog` |
| `core/src/runtime/data-provider.ts` | `getLogs` / `clearLogs` 的空间感知 |
| `core/src/controllers/admin/account-routes.ts` | `space` 参数、快照按空间重推 |
| `core/src/controllers/admin/socket.ts` | 订阅快照按空间分推 |
| `web/src/utils/log-space.ts` | 前端空间判定（与服务端一致） |
| `web/src/stores/status.ts` | `farmLogs` / `ranchLogs` 双缓冲 |
| `core/tests/log-space-quota.test.js` | 分流、截断、可见条数、清理的测试覆盖 |
