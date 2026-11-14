# dsh-costpilot v1.0

DeepSeek Harness 成本治理插件：成本账本 + 9 个成本优化模块 + dock UI。默认 `mode: observe`（只记账/只记录决策），高风险模块默认关闭，确认基线后再逐项开启。

## 模块与实现状态

| 模块 | 设计目标 | 实现 | 默认 |
|---|---|---|---|
| Phase 0 账本 | provider usage 四桶 → 金额（CNY/¥） | ✅ `session/event` 采样、NDJSON 账本、turn/tool 归因、attempt/retry 替换采样 | 开 |
| M1 工具输出压实 | post-execute 近无损压缩 | ✅ 确定性压缩（log/json/diff/table/code）、side-store 原文、可重放 marker | 开（继承 mode） |
| M2 上下文 GC | 区间级历史回收 | ✅ 规则打分选区间 + compaction 事件协议写入；默认关闭（需缓存模型校准） | 关 |
| M3 子任务栈 | 阶段分段 + 段聚合 | ✅ 阶段分类/段检测/模板摘要；与 M2 共用压缩器 | 关 |
| M4 元数据检索 | 跨会话 SQLite 索引 | ✅ `index_query` 工具 + `<workspace>/.dsh-costpilot/index.db`（files/entries/meta）跨会话复用 | 开（v1.0 默认） |
| M5 批处理引导 | 减少轮次 | ✅ pre-step 自适应 nudge（≤140 token，限次，自动关闭） | 关 |
| M6 工具集调度 | 降低前缀 schema | ✅ 阶段/候选白名单 → `tools.restrict({deny})`（下一步生效） | 关 |
| M7 路由 | 低风险阶段降级 | ✅ `agent.model.select()`（下一步生效，切换上限） | 关 |
| M8 重复调用 | 消除重复调用 | ✅ advisory / deny-with-pointer + 缓存原语（TTL、canonical args）；cache 执行路径实验性 | 关 |
| M9 预算守卫 | 失控/预算熔断 | ✅ 每 step 检查（步数/工具数/预算/尖峰/零进展/子代理/工具配额/连续硬限），steer 告警；hardStop 默认关 | 开（继承 mode） |
| UI | dock 状态/效果 | ✅ composer dock 胶囊（成本/节省/告警）+ 点击明细面板，结构与 sibling pill 一致 | 开 |

## 安装（本地 bundle）

推荐配置模板：[examples/desktop-profile-costpilot.yml](examples/desktop-profile-costpilot.yml)（observe + M4 开启，其余按需）。v1 代码更新后需重启 DSH 使新插件代码生效。

```bash
export DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
cd /path/to/dsh-costpilot
"$DSH" plugin --profile desktop add "link:$PWD"
```
之后在 profile 用户层（`~/.dsh/profiles/desktop/cordis.patch.yml`）放配置；desktop profile 由 Electron 独占，改完依赖 HMR/重启生效。详细步骤与已安装路径见 [INSTALL.md](INSTALL.md)。

## 配置（完整默认值见 lib/config.js）

```yaml
- id: costpilot
  name: dsh-costpilot
  config:
    mode: observe                 # observe | assist | enforce
    currency: CNY                 # 金额单位；UI 显示 ¥
    peakPricing: { timeZone: Asia/Shanghai, windows: [{ days: [1,2,3,4,5], start: '09:00', end: '12:00' }, { days: [1,2,3,4,5], start: '14:00', end: '18:00' }] }
    dataDir: ~/.dsh/costpilot
    usageSemantics: exclusive     # DSH 归一化：inputTokens = 未缓存输入
    pricing:                      # ¥ / 1M tokens（DeepSeek 官方价，空闲价为高峰价一半）
      deepseek-account:
        default:
          uncachedInput: 1      # 空闲
          cacheWrite: 1
          cacheRead: 0.02
          output: 4
          peak: { uncachedInput: 2, cacheWrite: 2, cacheRead: 0.04, output: 8 }
    budgets: { sessionUSD: 5, taskUSD: 20, warnAtPct: 80, hardStopAtPct: 120 }
    modules:
      M1: { enabled: true, minDeltaTokens: 400, sideStore: true }
      M2: { enabled: false, tauLineReuse: 0.3, maxRegionRatio: 0.6, allowWithBuiltinCompaction: false }
      M3: { enabled: false, segmentSteps: 6, minStepsBefore: 10 }
      M4: { enabled: true, indexPath: .dsh-costpilot/index.db, maxFiles: 5000, maxRows: 200 }
      M5: { enabled: false, maxInjections: 3, firstTurns: 5 }
      M6: { enabled: false, maxSwitches: 3, keep: [bash, read, write, edit, glob, grep, run_code] }
      M7: { enabled: false, routeDown: { provider: deepseek-account, model: deepseek-flash }, phases: [search, read] }
      M8: { enabled: false, level: advisory, allowTools: [read, glob, grep, index_query] }
      M9: { enabled: true, maxSteps: 160, maxToolCalls: 400, maxTurnCostUSD: 1, hardStop: false }
```

- `mode: observe`：所有模块只记录决策，不改写、不 steer。`assist` 才真正动作。
- 金额与价目：默认人民币、DeepSeek 官方价（[价目页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)）：deepseek-flash 空闲时段 cache 命中 ¥0.02 / 未命中 ¥1 / 输出 ¥4 每 1M，高峰时段翻倍（北京时间工作日 09:00–12:00、14:00–18:00）；按每次调用时间自动选档。未知 route 不显示假金额（pill 改显示 cache 命中率）。
- `sessionUSD` / `maxTurnCostUSD` 为历史字段名，数值单位 = `currency`。

## 数据与跨会话

> 本仓库已预构建一份 workspace 索引：`.dsh-costpilot/index.db`（1094 文件 / 17313 entries，约 3.9 MB）。启用 M4 后同一 workspace 的所有会话直接复用它，`index_query` 只做增量刷新。

```
~/.dsh/costpilot/
├── sessions/<sessionId>.jsonl      # 每会话成本账本（跨会话可聚合）
└── originals/<session>/<callId>.txt# M1 原文（TTL 清理，默认 30 天）

<workspace>/.dsh-costpilot/index.db # M4 跨会话元数据索引（SQLite，只读查询；启用 M4 后首次 index_query 构建）
```

M4 索引按 **workspace 根** 保存，同一 workspace 的所有会话复用；表 `files(path,name,language,lines,mtime,size)` 与 `entries(path,name,kind,parent,line_start,line_end,meta)`。`index_query` 仅接受单条 SELECT（无 PRAGMA/ATTACH/写操作），自动加行数上限。

## UI

- dock 胶囊：`¥0.012 · −1.2K · !1`（成本 / M1 节省 / 告警数）；tooltip 与点击面板给出 cache 命中、四桶 token、M1 明细、guard 原因、route、模块状态。
- 结构与 sibling pill 相同：`span[data-composer-stat=costpilot] > Tooltip > button.pill > (svg + span.label)`；点击打开明细面板（Esc/外点关闭）。
- projection key `costpilot`，仅折叠标准 session 事件与 planted markers（M1/M9），resume/fork 可重建。

## 命令

- `/cost`：当前会话成本报表（¥）。
- `/costpilot status`：模块与模式状态。
- `/costpilot on M4` / `off M4` / `on all` / `off all`：运行时开关（不落盘）。
- `/costpilot simulate`：静态估算（无模型调用）——按 cache-read 价与剩余调用数折算已记录压缩的节省。
- CLI：`node bin/costpilot-sim.mjs [--dir ...] [--session ...] [--json]`（跨会话聚合，含 cost=¥…）。

## 安全边界

- M2/M3 默认关闭：它们通过 compaction 事件协议改写历史，要求 `ctx.compaction` 不存在或显式 `allowWithBuiltinCompaction: true`，且必须与内置 compaction 互斥（锁）。
- M4 SQL 只读白名单 + 行数上限 + 忽略敏感文件（`*.pem/*.key/*.env*`）；索引只存元数据，不存文件内容。
- M8 cache 执行路径为实验性（`level: cache`），默认 advisory/deny；伪造调用会缺 provider usage，审计日志会标记。
- 所有模块有 try/catch，失败只记录不阻断宿主 turn；`observe` 模式绝不改写。

## 开发 / 测试

```bash
cd dsh-costpilot
node --test test/*.test.mjs    # 全部单元 + 集成 + 客户端结构 + 验收（无网络）
node bin/costpilot-sim.mjs --dir ~/.dsh/costpilot/sessions
```

合约：[IMPLEMENTATION-v1.md](IMPLEMENTATION-v1.md)、[SPEC.md](SPEC.md)；评审与处置：[IMPLEMENTATION-REVIEW.md](IMPLEMENTATION-REVIEW.md)、[REVIEW-RESPONSE.md](REVIEW-RESPONSE.md)、v1 评审 [IMPLEMENTATION-V1-REVIEW.md](IMPLEMENTATION-V1-REVIEW.md)、[REVIEW-RESPONSE-V1.md](REVIEW-RESPONSE-V1.md)。

## 已知限制（v1.0）

- **M2/M3 在默认 desktop preset 下不会运行**：它们走 compaction 事件协议，只允许在没有挂载 `compaction` 服务的 preset 中启用（避免与内置 compaction-basic 并发写 surface）。要启用需提供不挂载 compaction-basic 的 preset，或将来以官方 `CompactionEngine` 形态替换后端。
- M2 的行级复用预测用规则打分（GBDT 需离线训练数据）；M8 的 `cache` 执行路径为实验性（默认 advisory/deny）。
- M9 已实现 hardStopSteps 连续硬限、子代理调用限额、工具配额、edit 型 workspace 进展检测；真实 subagent 生命周期计数仍是 tool-call 近似。
- M4 首次 `index_query` 同步构建索引（大仓需预建或后台化）；`queryTimeoutMs` 只有 busy_timeout。
- 全部 216 条测试在 mock cordis + 隔离 profile 装载下通过；**真实 GUI 进程内的 session append / compaction 锁 / tokenUsage 投影 / fs/observed 回归仍需一轮实测**。