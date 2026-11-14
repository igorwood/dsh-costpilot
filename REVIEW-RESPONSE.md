# CostPilot v0.1：验收评审处置说明

对应 [IMPLEMENTATION-REVIEW.md](IMPLEMENTATION-REVIEW.md)（acceptance-verifier，P0×1 / P1×6 / P2×15）。本文件记录处置结论与证据。

## P0（已修复）

**P0-1 usageSemantics 默认值与 DSH 相反**
- 证据：`dsh-token-meter/lib/index.js` 把 `usage.inputTokens` 直接映射为 `uncachedInputTokens`；`dsh-llm-deepseek` 设 `totalTokens = input + output + cacheRead + cacheWrite`。即 DSH 归一化后的 `inputTokens` 就是**未缓存**输入。
- 修复：`lib/config.js` 默认 `usageSemantics: 'exclusive'`；`lib/contracts.js#normalizeUsage` 默认改 exclusive；projection 默认同步；ledger 测试显式用 inclusive 验证另一条路径，并新增默认值断言。
- 影响：cache 密集会话不再少计 USD。`test/core.test.mjs` 新增 `config: shipped default usageSemantics ...` 用例。

## P1（5 项修复，1 项延后）

| # | 问题 | 处置 |
|---|---|---|
| P1-1 | M1 在 accept 带 `value` 时仍返回 `content`，触发宿主 TypeError | **已修复**：`index.js` 先判断 `decision.value !== undefined` 直接透传，不做内容改写 |
| P1-2 | 未采样 `assistant/attempt` / `llm/retry*`（重试计费） | **延后**（见下）：需要"同 turn/step 替换采样"语义，v0.1 直接相加会双计；优先级低于 P0，Phase 0 对账任务会量化缺口 |
| P1-3 | 命令/projection 未挂 `ctx.effect`，卸载泄漏/重名 | **已修复**：两处注册都包在 `ctx.effect(() => { ... return disposer })`；`test/mock-ctx.mjs` 的 effect 语义改为 Cordis 式（调用回调、保存其返回的 disposer） |
| P1-4 | resume 后 `/cost` 少报（内存账本为空） | **已修复**：`getSummary` 在 calls=0 且无 byModule 时返回 undefined，命令回落到持久化账本 `summarizeStore` |
| P1-5 | side-store 无 TTL（`deleteOriginalsAfterDays` 死配置） | **已修复**：`apply` 时按配置清理超过 N 天的原文（默认 30 天；=0 关闭） |
| P1-6 | 缺 tokenUsage 聚合对账 | **延后**：需要读取 `tokenUsage` projection 的注册句柄；计划在 Phase 0 的 sim/对账报告中实现（见设计 §8.6 Phase 0 出口），不阻塞 v0.1 |

**P1-2 延后理由**：`assistant/attempt` 与随后的 `assistant/message` 可能携带同一 attempt 的 usage（tokenMeter 的 fold 用"同 turn/step 替换"处理）。若 v0.1 简单相加会双计，反而比不采样更差。正确处理需要引入 per-(turn,step) 采样替换与负数调整记录，并同步 `sim` 汇总；已列为 Phase 0 对账任务的子项。

## P2（选择性处理）

- M9 的 `hardStop` 仍为"单步超阈值 + hardStop=true"（未实现设计 §6.9 的"连续 2 步超限"）——**保留**：默认 hardStop=false，风险可控；在 README 的 v0.1 限制中说明。
- M1 的 `minDeltaTokens` 同时用于"原始大小"和"净节省"两道门——**保留**：双门控是保守选择，已在单测覆盖。
- secret 正则较宽——**保留**：宁可不压实，不泄漏。
- side-store 覆盖风险（同 callId 重写）——**保留**：callId 在 session 内唯一；跨 resume 的同 callId 极罕见，且 TTL 清理降低残留。
- `client.js` factory 内的 CSS 注入副作用——**保留**：与 shell 内建 client 插件的做法一致，且用 `style[data-plugin-css]` 去重。
- sim 无 pricing/policy 输入、无基线还原——**保留**：v0.1 只做账本聚合报表，离线模拟器（设计 §8.2）列为 Phase 0+ 工作。

## 回归

`cd dsh-costpilot && node --test test/*.test.mjs` → **86/86 通过**（6 个测试文件：client 4 · core 28 · hooks 29 · integration 5 · projection 6 · acceptance 14）。真实装载（隔离 `DSH_HOME`）已验证 host 插件 apply 与 web client preload。