# 日志文件分割与定时清理

本文说明服务端日志文件的落盘策略：如何按天分割、单文件超限如何切分、过期日志如何定时清理，以及相关环境变量。

## 背景与问题

长期挂机运行时，日志文件会持续增长。改造前的情况：

- `data/logs/combined.log` 与 `data/logs/error.log` 由 winston 的 `File` transport 写入，**没有任何大小上限与保留期**，只增不减。
- 本项目是**多进程模型**：主进程 + 每个农场账号一个 worker 子进程（fork 或 thread），所有进程都往同一个目录写日志。`combined.log` 里 `Protobuf 定义加载完成` 出现 229 次，即为每个 worker 各写一遍的证据。
- `app_dev.log` 是 `start.sh` 里进程 stdout/stderr 的重定向目标，单次长跑同样会累积。

## 方案总览

| 维度 | 策略 |
| --- | --- |
| 分割维度 | 按天（`combined-20261120-<pid>.log`） |
| 单文件上限 | 超过后按序号切分（`....1.log`、`.2.log`） |
| 保留期 | 默认 7 天，定时清理过期文件 |
| 总容量 | 默认 200 MB，超限时按最旧优先删除 |
| 清理时机 | 后台定时（默认 60 分钟）+ 进程启动时立即执行一次 |
| stdout 日志 | `app_dev.log` 按行数保留尾部（默认 20000 行） |

## 为什么不用 winston 内建的 maxsize/maxFiles

winston 的 `File` transport 支持 `maxsize` / `maxFiles`，但其轮转依赖 `rename` + `unlink`。在本项目的多进程模型下这会出问题：

- 进程 A 把 `combined.log` 改名为 `combined1.log` 后，进程 B 持有的文件描述符仍指向**已被改名的旧 inode**，B 后续的日志写进一个用户再也访问不到的文件。
- 两个进程可能同时判定同一个文件该被删除，产生竞态。

因此本项目改为自研写入器，**全程不做 rename/unlink**，只用「排他创建 + 追加」。

## 文件命名

```
data/logs/
  combined-20261120-12345.log        # 主进程，2026-11-20
  combined-20261120-12345.1.log      # 主进程，同一天切出的第 2 个文件
  combined-20261120-23456.log        # worker 进程（pid 不同）
  error-20261120-12345.log           # 仅 error 级别
```

- 日期键为本地日期 `YYYYMMDD`，跨天自动切换到新文件，序号从 0 重新开始。
- 文件名含 **pid**：每个进程写自己的文件，同一天同账号的多进程不会互相切分，也不会互相覆盖。
- `error` 系列只记录 `error` 级别；`combined` 系列记录全级别。

## 并发安全设计

写入器的三条硬约束：

1. **排他创建**：新文件用 `wx` 标志创建。若目标已存在（可能是 pid 复用后上一轮运行的残留），递增序号重试，**绝不追加到非本次进程创建的文件**——否则会把不同轮次的内容混在一起。
2. **只追加不截断**：一律用 `a` 标志追加。O_APPEND 下同文件的单次写入是原子的，多进程并发追加不会互相截断。
3. **进程内串行**：写入走队列，保证单进程内的写入顺序与字节计数准确。

清理器同样考虑并发：

- 正在写入的活跃文件永不删除（由写入器提供 `activeFilePath`）。
- 多个进程可能同时判定同一文件该删；删除失败（文件已被他人删除）静默忽略。

## 日志行格式

保持与改造前完全兼容，字段顺序不变，既有 grep 规则与分析工具继续可用：

```json
{"app":"qq-farm-bot","level":"info","message":"添加罐头完成","module":"ranch","event":"ranch_useCan","result":"ok","tag":"牧场","timestamp":"2026-11-18T00:15:46.757Z"}
```

- `app` / `level` / `message` / `module` / `timestamp` 为固定字段。
- 其余 meta 字段**平铺到顶层**（`module`、`event`、`result`、`tag` 等）。
- `module` 优先取显式 `meta.module`，其次才是模块 logger 名——与 winston child logger 的合并语义一致。
- 敏感字段（`token` / `password` / `ticket` / `cookie` 等）落盘前统一脱敏为 `[REDACTED]`。

控制台输出仍由 winston 的 `Console` transport 承担（保留彩色格式化），文件落盘由自研写入器独立完成，两者互不影响。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `FARM_LOG_LEVEL` | `info` | 落盘级别：debug / info / warn / error，低于该级别不写文件 |
| `FARM_LOG_MAX_FILE_SIZE_MB` | `20` | 单个日志文件大小上限（MB），超过后切分 |
| `FARM_LOG_RETENTION_DAYS` | `7` | 日志保留天数，超过则定时删除 |
| `FARM_LOG_MAX_TOTAL_SIZE_MB` | `200` | 日志目录总大小上限（MB），超出按最旧优先删除 |
| `FARM_LOG_CLEANUP_INTERVAL_MINUTES` | `60` | 定时清理间隔（分钟） |
| `FARM_LOG_DAILY_SPLIT` | `1` | 设为 `0` 关闭按天分割（仅按大小切分） |
| `FARM_STDOUT_LOG_MAX_LINES` | `20000` | `app_dev.log` 保留的最大行数 |
| `FARM_STDOUT_LOG_TRIM_INTERVAL` | `300` | `app_dev.log` 裁剪间隔（秒） |

配置定义在 `core/src/config/log-system.ts`，读取惯例与 `user-system.ts` 一致。

## 相关代码

| 文件 | 职责 |
| --- | --- |
| `core/src/config/log-system.ts` | 环境变量配置项 |
| `core/src/services/log-file-writer.ts` | 按天分割 + 序号切分的写入器 |
| `core/src/services/log-cleaner.ts` | 保留期与总容量两条清理规则 |
| `core/src/services/logger.ts` | 落盘入口（控制台与文件分离） |
| `start.sh` | `app_dev.log` 的后台裁剪循环 |

`app_dev.log` 的裁剪用「清空 + 重写」而非 `mv`，目的是保持 inode 不变——`node` 持有的 append 文件描述符仍指向同一个文件，不会出现写入已删除 inode 导致日志丢失。

## 验证

```bash
# 构建
pnpm -C core build:ts

# 运行日志相关测试
cd core && node --test tests/log-file-writer.test.js
```

`core/tests/log-file-writer.test.js` 覆盖：按天分文件、超限序号切分、不覆盖已存在文件、关闭后拒写、清理器保留期规则、清理器容量规则、活跃文件保护、目录不存在时的安全返回、落盘格式兼容性。
