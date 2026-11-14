# dsh-costpilot v0.1 实现说明（Phase 0 + M1 + M9）

依据：design/DeepSeek-Harness-Cost-Efficiency-Plugin-Design.md（v1.1）。
范围：只读账本（Phase 0）+ M1 工具输出压实 + M9 预算/失控熔断 + /cost 命令 + 离线报告 CLI。
非范围：M2–M8、客户端 UI、SQLite（v0.1 用 NDJSON，接口可替换）、preset/compaction 替换。

## 包形态
- 纯 ESM，零运行时依赖；**不 import cordis/schemastery**（函数式插件：export name/inject/apply）。
- 配置由 lib/config.js 自行校验（无 Config 导出，避免依赖 schemastery）。
- 可安装 bundle：package.json 的 `dsh.bundle.patch = "./cordis.patch.yml"`，patch 插入一行 `id: costpilot, name: "dsh-costpilot"`。

## 模块与文件
| 文件 | 责任 | 负责人 |
|---|---|---|
| index.js | 插件入口：apply(ctx, config)，注册 4 类监听 + 命令 + 清理 | Lead |
| lib/contracts.js | 常量与 JSDoc 类型（唯一契约） | Lead |
| lib/config.js | 默认值/解析/校验/价格表 | Lead |
| lib/pricing.js | 价格解析与 usage→金额（默认 CNY） | A |
| lib/estimate.js | 4 chars/token 估算（文本/消息/工具结果/工具 schema） | A |
| lib/ledger.js | 会话账本：采样事件、归因、汇总、flush | A |
| lib/store.js | NDJSON 追加/读取/目录管理（原子写、rotating） | A |
| lib/oracle.js | Eq.2（suffix 断点版）、剩余步数启发式、缓存状态、决策 | A |
| lib/compress.js | M1 确定性压实 + side-store | B |
| lib/guard.js | M9 计数器/预算/零进展/熔断决策 | B |
| lib/commands.js | /cost 命令 | Lead |
| lib/projection.js | 客户端可见的 `costpilot` session projection（纯事件折叠） | Lead |
| client.js | client 半：composer dock pill（结构与 sibling 一致） | Lead |
| lib/sim.js + bin/costpilot-sim.mjs | 读账本出报告 | Lead |
| test/mock-ctx.mjs | 迷你 cordis（on/waterfall/emit/inject/effect） | Lead |
| test/core.test.mjs | pricing/estimate/ledger/oracle/store | A |
| test/hooks.test.mjs | compress/guard | B |
| test/integration.test.mjs | 插件全链路（mock ctx） | Lead |
| test/acceptance.test.mjs | 黑盒验收（不读实现内部） | C |
| IMPLEMENTATION-REVIEW.md | 代码评审 | C |

## 关键契约（详见 lib/contracts.js）
- usage：`{ inputTokens?, outputTokens?, cacheReadTokens?, cacheWriteTokens?, totalTokens? }`
- route：`{ provider, model }`，来自 request/header 的 `header.config`（含 reasoningEffort 可选）
- costEvent（账本一行）：`{ v:1, kind:'llm_call'|'tool_call'|'tool_result'|'mutation'|'guard'|'turn'|'session', sessionId, seq?, turn?, step?, ts, route?, usage?, usd?, confidence, ... }`
- 事件采样：只认 session/event 的 `event.type`；assistant/message 的 `data.usage`；request/header 的 `data.header.config` 与 `data.startsSeries`；tool/call、tool/result、turn/start|end、step/start|end、compaction/summary。
  **注意**：`request/header` 发生在 assistant/message 之前；ledger 必须缓存"最近 route"。
- M1：`tools/post-execute (exec, result, next) => PostToolDecision`；先 `await next()`，若为 accept 且 content 可压 → 返回 `{kind:'accept', content}`；否则原样返回。原文写 side-store，账本记 mutation。
- M9：`agent/pre-step ({agent,messages,turn,step,signal,modelSelection}, next) => PreStepDecision`；先 next()；预算/零进展告警 → 若 decision 为 enter 则追加一条 user 消息（source.kind='costpilot'），并记 guard 事件；hardStop（默认关）→ `agent.cancel(cause,{keepInbox:true})` 并返回 `{kind:'reject'}`。
- 命令：`ctx.commands.register({name:'cost', description, handler(invocation) => ({kind:'success', text})})`；用 `ctx.inject(['commands'], ...)` 可选注册。

## UI 契约（client 半）
- client 入口：`window.__ModuleLoader__.load({ id: 'dsh-costpilot', factory(require) { ... } })`；`exports.inject = ['slots']`。
- 注册：`ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({ name:'conversation.composer.dock', id:'costpilot', order:2 }, CostPilotPill))`。
- 组件结构必须与 sibling pill 相同：`span[data-composer-stat] > Tooltip > span.pill > (svg + span.label)`；用同一组 `--dsw-*` token 的 CSS；无数据返回 null。
- 数据只来自 `useProjection('costpilot')`；projection 由 host 注册（`key:'costpilot'`, `stateVersion:1`, identity schema, `wire.view`）。
- 可重放标记：M1 在压缩结果末尾追加 `[costpilot:m1 removed_tokens=N added_tokens=M pointers=P]`；M9 在 steer 文本前加 `[costpilot:guard action=warn|stop reason=slug]`。
- 结构测试：`test/client.test.mjs`（4 条）；投影测试：`test/projection.test.mjs`。

## 数据目录
`${DSH_HOME:-~/.dsh}/costpilot/`
- `sessions/<sessionId>.jsonl`（每会话 append-only 账本）
- `originals/<sessionId>/<callId>.txt`（M1 原文）
- `meta.json`（版本、配置快照摘要）

## 测试与验收
- `node --test test/` 全绿；零外部依赖；无网络。
- 集成：mock ctx 模拟 2 turns / 3 次 llm 调用 / 2 次工具调用（1 次超大输出），断言：账本行数、金额≈手算（CNY）、M1 压缩后 content 变短且 side-store 存在、/cost 文本含 "¥" 与 session id、预算超限触发 guard 事件。
- 真实加载：`dsh --profile costpilot-test --dump-config` 中能看到 costpilot 行（安装成功）。