# v1.0 独立评审处置（IMPLEMENTATION-V1-REVIEW.md）

对应 [IMPLEMENTATION-V1-REVIEW.md](IMPLEMENTATION-V1-REVIEW.md)（P0×2 / P1×9 / P2×17）。

## P0（已修复）

| P0 | 修复 |
|---|---|
| P0-1 M2/M3 无净收益门控 | `index.js` 在 `compactor.run` 前要求 `plan.netUSD > 0`；否则只记 `metric: compaction-deferred`（含 netUSD/deltaTokens）并跳过。节流窗口不再被空计划/失败消费（仅成功或 defer 后更新）。 |
| P0-2 与内置 compaction 共存绕过唯一写者 | 删除 `allowWithBuiltinCompaction` 放行路径：**只要 `ctx.get('compaction')` 存在，M2/M3 一律不写**。M2/M3 只允许在未挂载 compaction-basic 的 preset 中运行（或将来以官方 CompactionEngine 形态替换后端）。配置项已移除。 |

## P1（已修复 8，部分修复 1）

| P1 | 处置 |
|---|---|
| P1-1 fs/observed 签名错误 | 改为 `(target, observation, actor)`，从三者提取 path/changes；只对匹配 workspace 根的索引 markDirty。 |
| P1-2 tokenUsage 对账用假 session | `reconcile(state, session)` 现在传入真实 session（turn/end 事件中的 session），使用 `stateOf(session,'tokenUsage')`。 |
| P1-3 /costpilot on 对已有会话假生效 | 策略实例改为**惰性创建**（M5/M6/M7/M8），运行时开关后下一次使用会按新配置重建；M4 运行时注册/注销保持。 |
| P1-4 M1 压缩跳过 M8 记录 | post-execute 在判定 accept/value 后**先** `recordRepeat` 再走 M1 压缩；M1 开时 M8 仍能命中。 |
| P1-5 M6 未知工具不恢复 | 监听 `tool/result` 的 `error.code`（含 UNKNOWN_TOOL）→ 依次执行保存的 restrict disposer 并 `noteUnknownTool`，记录 `toolset-restore`。 |
| P1-6 M5 触发/自适应/指标 | 补 `recentToolNames` 环形缓冲（tool_call 更新）、turn/end 调 `shouldDisable` 置 per-session `nudgeDisabled`；nudge 改记 `metric: m5-nudge`，不再计入 guard 告警。 |
| P1-7 /cost resume 少报 | `summaryFor` 优先使用持久化账本（`summarizeStore`），无数据再回落到内存账本。 |
| P1-8 observe 不记录决策 | M2/M3（plan 后记录 netUSD）、M5、M6、M7、M8 在 observe 下记录 `metric` 决策；M1 仅执行、不改写。 |
| P1-9 节流窗口被失败消费 | 只在 `run ok` 或 `compaction-deferred` 后更新 lastCompactionAttempt；busy/异常不消费窗口。 |

## 其它同步修复

- `compaction/summary.provider/model` 由 null 改为 **空字符串**（DSH 持久化类型为 string）。
- guard 汇总只统计 `warn/stop`；nudge/toolset/route/audit/observe/compaction 决策进 `metrics`（ledger summary 与 sim 均新增 `metrics` 计数）。
- P2 中已顺手修：compactor 类型、M4 索引按 workspace 过滤失效、M8 记录顺序、M6 disposer 保存。

## 追加修复（goal round 2）

- **M9 扩展**：`hardStopSteps` 连续 N 次超限才硬停；子代理调用限额（tool-call 近似）；`toolQuotas` 单工具配额；edit/write 成功算 workspace 进展，连续无进展告警；`noteWorkspaceChange` 暴露给外部。
- **M4 默认开启**（v1.0 交付选择）：DEFAULTS 中 `M4.enabled=true`；可在 config 关闭。索引仍在首次 `index_query` 时惰性构建。
- 指标与 guard 分离：nudge/toolset/route/audit/observe 决策记 `metrics`，不再污染 guard 告警计数。
- 测试更新：216/216（新增 M9 连续硬限/spawn 限额测试，修正 hardStopSteps 兼容性）。

## 未修复 / 已知限制（明确记录）

- M2/M3 仍不是官方 `CompactionEngine`：普通 desktop preset 挂载了 compaction-basic，因此 **M2/M3 在默认部署下不会运行**（这是 P0-2 的安全选择）。要启用需提供不挂载 compaction-basic 的 preset。
- M9 的 `hardStopSteps`、subagent 限额、workspace 变更零进展仍未实现（沿用 turn 级 guard）；README 明确为 v1 近似。
- GBDT 行级复用预测未训练（M2 用规则）；M8 cache 执行路径仍实验性；M4 大仓库构建时间/查询超时未压测；sim 仍是账本聚合而非 DSH 日志全量重放。
- 真实运行时回归（Session append 校验、compaction 锁、tokenUsage 投影、fs/observed 真实事件、tools.restrict scope）尚未在 GUI 进程内执行；当前证据为 mock 合约 + 真实 profile 装载（v0.1/v1 早期）。