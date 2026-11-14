# dsh-costpilot v0.1 独立验收与代码评审

- 验收人：acceptance-verifier（独立于实现）
- 范围：Phase 0 账本 + M1 + M9 + /cost + projection/client + sim；未修改实现文件。
- 证据来源：SPEC.md / README.md / INSTALL.md / design v1.1 §5.1、§5.2、§6.1、§6.9、§8.1、§8.2、§8.6 / 全部实现文件 / DSH 0.2.2-rc.1 运行时包契约（app.asar 内 @deepseek-ai/dsh-tools、dsh-agent、dsh-agent-loop、dsh-session、dsh-token-meter、dsh-llm-deepseek、dsh-client-ui-conversation、dsh-commands 的实测）。
- 结论：**功能验收通过，账本默认语义有 P0 级偏差**。既有 71 条测试 + 本次新增 14 条黑盒验收 = **85/85 通过**；真实 profile 装载成功（详见 §1）。

---

## 1. 装载验证（真实 CLI，仅新建 profile）

隔离方式：export DSH_HOME=/path/to/AgentOptimization/.dsh-test；未读改 ~/.dsh/profiles/{desktop,web}。

| 步骤 | 命令 | 结果 |
|---|---|---|
| 建 profile | "$DSH" --profile costpilot-accept --from-default-profile headless --dump-config >/dev/null | exit 0 |
| 安装 link | "$DSH" plugin --profile costpilot-accept add link:/path/to/dsh-costpilot | exit 0（pnpm v11.28.5，187ms） |
| 用户层 patch | 在 <DSH_HOME>/profiles/costpilot-accept/cordis.patch.yml 写入 - id: costpilot / name: dsh-costpilot / config: ...（已备份 .bak） | 写入成功 |
| 配置树验证 | "$DSH" --profile costpilot-accept --dump-config 后 grep -A4 -i costpilot | 命中 "# == dsh-costpilot, patched by .../cordis.patch.yml" + 行内容 |
| overlay 验证 | --patch research/tmp/costpilot-overlay.yml --dump-config | loader 解析 overlay 并合并出 costpilot 行 |
| 实际激活 | "$DSH" --profile costpilot-accept boot --help | exit 0；<DSH_HOME>/costpilot/ 被创建，说明 apply() 已执行（index.js:37 ensureDir） |

结论：**真实装载成功**。client 半在真实 Web 页面是否挂载 dock 未做浏览器内验证（无页面控制），仅按宿主 slot 契约与渲染结构静态核对。

---

## 2. 验收测试

新增 test/acceptance.test.mjs（node:test，14 条，全绿）：只 import 公开入口（index.js、lib/projection.js、lib/sim.js、client.js）与 test/mock-ctx.mjs，不 mock 内部模块。

覆盖：四桶手算 USD（exclusive/inclusive 两种口径）、未知 route 只记 token、M1 压缩/ERROR 保留/side-store 原文可读/committed marker/确定性/secret 与 error 跳过、observe 不改写、M9 单次带 marker steer 且默认不 cancel、M9 hardStop 的 reject+keepInbox、projection 折叠 USD/M1/guard、client loader id/inject/dock 注册/结构/空数据、/cost 含 USD+sessionId、sim 的 total_usd 与 m1_removed。

运行：cd dsh-costpilot && node --test test/*.test.mjs → **tests 85 / pass 85 / fail 0**。

---

## 3. 与 design 契约的核对（实际核对结果）

| 契约 | 结论 |
|---|---|
| §4.6 R11 / §6.1 M1：post-execute 替换、不写 compaction/prune、原文 side-store、不可 log 回放 | **符合**（lib/compress.js:1-14、index.js:96-152 无 prune 写入） |
| §6.1 marker 可重放 | **符合**：marker 写入 committed tool/result 文本，projection 纯事件折叠（index.js:141-146、projection.js:20/87-96），验收测试已证明 resume/fork 可重建 |
| §6.1 确定性 | **符合**：同一输入两次 post-execute 输出一致（验收测试） |
| §6.1 敏感内容不压实/不写 side-store | **符合**（compress.js:23/435-438），但正则过宽（P2-6） |
| §5.2 Eq.2（oracle） | **基本符合**：lib/oracle.js:66-98 为 suffix/断点版，与附录 C 一致；M1 v0.1 未接 oracle（按 minDelta），属实现范围 |
| §6.9 M9 以 step/tool-call 为单位、默认不 cancel、keepInbox | **符合默认项**：guard.js:387-407、index.js:173-180 默认 hardStop:false，cancel 传 keepInbox:true |
| §5.1 账本不写 session log、独立账本 | **符合**（NDJSON append-only） |
| §5.1 采样路径（usage、retry 也计费、聚合校验） | **部分不符**：retry/attempt 未采样（P1-2）、无 tokenUsage 聚合校验（P1-6） |
| §8.1 指标/归因 | 提供 USD/token/guard/M1，缺 cache 效率、重取率、开火率、p95（v0.1 范围外，P2） |
| §8.2 sim | 只做 NDJSON 报告，缺 pricing/policy 输入与 side-store 基线还原（P2-5） |
| UI 契约（client 半） | **结构/loader 契约符合**；factory 有副作用、Tooltip 细节与 sibling 略有差异（P2-10） |

已核对通过的 DSH 宿主契约（避免“自造 API”）：tools/post-execute (exec,result,next) + {kind:'accept',content}；agent/pre-step ({agent,messages,turn,step,signal,modelSelection},next) + {kind:'enter'|'reject'}；agent/turn-stopping ({agent,turn})；agent.steer({content,source:{kind}})、agent.cancel(cause,{keepInbox})；ctx.commands.register；ctx.sessionProjections.register({key,stateVersion,init,apply,wire})（apply(state,event)）；conversation.composer.dock 的 standardProps 含 useProjection；client window.__ModuleLoader__.load({id,factory}) + inject:['slots']；bundle patch 使用 - insert: [...]。

---

## 4. 问题清单

### P0

**P0-1 默认 usage 语义与 DSH 归一化相反，cache 密集会话会严重少计 USD。**
- 位置：lib/config.js:11（usageSemantics: 'inclusive'）、lib/contracts.js:78-88、lib/ledger.js:206-208、lib/pricing.js:118-134。
- 证据：DSH 自身 @deepseek-ai/dsh-token-meter/lib/types/usage-projection.js:14-19 将 uncachedInputTokens 直接赋值为 usage.inputTokens；@deepseek-ai/dsh-llm-deepseek/lib/index.js:2019 明确 totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens。即宿主提供方 usage 的 inputTokens 是未命中缓存的输入（exclusive），DeepSeek/pi-ai 适配器都已在源头归一化为这四桶。
- 影响：默认配置下 uncached = input - cacheRead - cacheWrite。例：input=1000, cacheRead=8000, cacheWrite=1000 → 记成 0（正确应为 1000），且与页面 tokenUsage 投影对不上；Phase 0 门禁“账本与 provider usage 对账偏差 ≤1%”无法通过。验收测试 inclusive 一条固定了该行为，便于回归。
- 修复：默认改为 exclusive（或按 provider 配 usageSemantics），并在 turn/end 用 tokenUsage 投影做对账，偏差 >2% 时降级 confidence 并告警（与 P1-6 一并做）。

### P1

**P1-1 M1 可能把 accept 决策同时带上 value+content，导致宿主抛 TypeError、工具调用失败。**
- 位置：index.js:141-147；宿主契约见 @deepseek-ai/dsh-tools/lib/pipeline.js:684：“accept decision cannot replace both value and content”。
- 影响：任一上游/下游 tools/post-execute 监听器返回 {kind:'accept', value} 时，M1 仍读 result.content 并返回 {...decision, content} → 同一决策同时含 value/content → TypeError，工具结果失败。官方 dsh-spill-policy 用 Object.hasOwn(decision,'value') 防御（dsh-spill-policy/lib/index.js:239）。
- 修复：进入压缩前判断 if (Object.hasOwn(decision, 'value')) return decision。

**P1-2 未采样 assistant/attempt 与 llm/retry*，失败/重试的次数与 USD 少计。**
- 位置：lib/ledger.js:185-227（只处理 assistant/message）；index.js:73-93。
- 依据：design §5.1 明确“llm/retry / llm/retry-started（重试也计费）”；DSH tokenUsage 投影同时折叠 assistant/attempt 的 stream usage（dsh-token-meter/lib/types/usage-projection.js:60-66/97-100）。
- 修复：采样 assistant/attempt（从 data.stream 取最后一个 usage chunk）并处理 llm/retry-started 的替换槽；或直接消费 tokenUsage 投影。

**P1-3 /cost 与 projection 注册未挂到 ctx.effect，禁用/热重载后泄漏/重复注册。**
- 位置：index.js:219-251；lib/commands.js:51-72（register 返回的 disposer 被丢弃）；index.js:227-228（projection handle 被丢弃）。
- 影响：命令注册不随插件卸载释放，重载可能触发 duplicate command cost（dsh-commands 明确同 scope 重名抛错），且禁用后仍有 /cost；projection 卸载后仍是 live unit（refs 不释放）。官方模式是 ctx.effect(function*(){ yield ctx.commands.register(...) })（见 dsh-command-compact/lib/index.js:89-99）。
- 修复：两个注册都包进 ctx.effect，yield disposer / handle.dispose()。

**P1-4 进程内只汇总“本进程看到的事件”，resume/中途启用后 /cost 少报。**
- 位置：index.js:240-244、lib/commands.js:65。
- 影响：插件后加载/resume 时 states 的 ledger 只含新事件；getSummary 有值就不再读 store，历史成本丢失。
- 修复：/cost 永远 summarizeStore(storeDir, sessionId) 后再与 live tail 合并（按 seq 去重），或在 session/created 时从 store 回灌。

**P1-5 side-store 无 TTL/清理，deleteOriginalsAfterDays 是死配置。**
- 位置：lib/config.js:35（默认 30，全库仅此一处）；lib/compress.js:619-632 只写不删；README/INSTALL 宣称 TTL 清理。
- 影响：长会话/大输出无限增长，磁盘可被日志打满；设计“指针不可指向已清理文件”的红线无法验证。
- 修复：apply 时注册每日清理（ctx.effect + timer/jobs），清理时同步失效指针。

**P1-6 缺 §5.1 的“聚合校验”路径（tokenUsage 对账）。**
- 位置：lib/ledger.js（无 tokenMeter/tokenUsage 读取）、index.js（未 inject tokenMeter/sessionProjections）。
- 影响：Phase 0 Gate 的“对账偏差 ≤1%”无实现支撑；P0-1 的语义错误无自检。
- 修复：ctx.inject(['tokenMeter'])，在 turn/end 对比事件级累加与 ctx.tokenMeter.measure(session)/tokenUsage 投影，偏差写入 confidence 与告警。

### P2

1. **M9 hardStop 策略偏离 §6.9**：guard.js:394-405 只在 hardStop===true 且预算 ≥ hardStopAtPct（默认 120%）时 stop；design 为“≥100% 且连续 2 步超限”，且 max-steps 应“下一步仍超则 cancel”，当前只告警。lib/config.js:27/39-50。建议补连续步计数与 maxSteps 升级。
2. **零进展检测不含 workspace 变更**：guard.js:260-270/405 只看相同工具签名连续次数，任何不同调用都会重置；design 要求“无 workspace 变更且工具调用重复”。建议接 workspace/changes。
3. **告警去重双份且语义不同**：guard.js:358-370 用全局 counters.warned（任一原因告警后全抑制），index.js:166-169 按 reason 去重。结果是“首个原因赢”，后续不同风险被静默。建议统一为 per-reason 或文档化。
4. **projection 与 ledger 口径不一致**：projection.js:67-85 无 route 时完全跳过 usage（ledger 会从 session.requestHeader() 恢复，ledger.js:99-131），resume/中途挂载后 dock 与账本不同；state.usd 累加不 round（最后 toFixed(6)）vs ledger 每笔 roundUSD(1e-8)，有微小漂移。建议共享 pricing helper、补 attempt、按 seq 归并。
5. **sim 口径不完整**：lib/sim.js:47-66 硬编码 input - read - write，忽略 config 的 usageSemantics（exclusive 配置下 token 桶同样错）；无 pricing/policy 输入、无 side-store 基线还原（design §8.2），无法回答“节省”。建议复用 pricing/normalizeUsage，缺基线时显式拒绝节省结论。
6. **secret 正则过宽**：compress.js:23 命中裸 token，任何提到 token/tokens 的输出（含 usage 日志）都不压实，显著降低 M1 命中率。建议改为 api[_-]?key|secret|password|passwd|private key|bearer 的行级判定。
7. **minDeltaTokens 被复用于输入下限和节省下限**：compress.js:551-562。默认 400 意味着 <400 token 不压（符合 §6.1）且省不到 400 token 也不压，语义模糊。建议拆成 minInputTokens / minSavedTokens。
8. **side-store 覆盖风险**：index.js:117-127 用 callId ?? 'unknown' 命名；同一 session 多个无 callId 或重试同 callId 的结果会互相覆盖，丢失取证原文。dataDir 仅 expandHome（config.js:83-86），未限制在工作区/绝对路径校验；writeSideStore 的 safeSegment 本身能挡路径穿越（compress.js:594-603，已有单测）。
9. **每事件同步写盘 + 全量内存**：ledger.js:144-147 保存所有事件、store.js:96 每次 appendFileSync；summary() 为 O(n)（ledger.js:419-455），/cost 每次全扫。Phase 0 建议批量/异步或直接 SQLite，并给大输出（10MB）做基准。
10. **client factory 有副作用**：client.js:28-35 在 factory 执行期注入 style 且无清理，违背 DSH 插件开发 skill 的“Keep factories free of side effects，注册资源放 apply 并返回 cleanup”；禁用插件后样式残留。另 onlyWhenClipped:false（client.js:111）与 sibling 的 FULL_READING_TOOLTIP.onlyWhenClipped:true 不同（结构 anchor>Tooltip>pill>icon+label 本身一致）。
11. **M1 与 spill-policy 叠加**：M1 先压缩并把 marker 作为独立 text block 追加（index.js:144-145），spill-policy 是 prepend 且合并相邻 text block 再 bound（dsh-spill-policy/lib/index.js:225-255）。两者同开会话时 marker 可能被截断/合并，且两份预算互相抵消；design §6.1 建议二选一。M1 也未区分 PTC 子调用（exec.parent）。
12. **事件字段小偏差**：ledger.js:272-283 的 turn/end.reason 实为对象 {kind}，当前丢弃（只保留字符串）；step/start|step/end 记成 kind:'turn' + extra.event（ledger.js:285-292），summary/sim 需靠 extra 判定，语义易混淆。建议保留 reason.kind、引入 kind:'step' 或在契约写明。
13. **/cost 展示**：commands.js:24 对 confidence !== 'provider' 一律标 “(heuristic)”，unknown route 实际是 unknown；建议区分。另无 /costpilot off 等 §6.9 要求的解除入口（v0.1 范围外，记录）。
14. **预算降级阶梯缺失**：§5.3 ladder（nudge→prune→compact→route-down→stop）未实现，当前只有 warn/stop（index.js:154-197）。v0.1 可接受，但验收文档不应暗示已覆盖。
15. **cancel cause 未验证枚举**：index.js:175 用 {kind:'costpilot', reason}；dsh-agent README 只展示 cancel(cause,{keepInbox})，未给 cause 联合类型，建议对真实 agent 跑一次闭环或与宿主确认。

---

## 5. 测试缺口

1. 没有以真实 DSH session log 片段为 fixture 的验收：assistant/attempt、llm/retry*、request/header.reason=change/series、tool/result.data.error 均未覆盖（P1-2 无法被现有测试发现）。
2. 没有 tokenUsage 投影/宿主 usage 的对账测试（P0-1、P1-6 的回归缺口）。
3. M9 只有单元级（guard.checkPreStep）与一条集成，缺“单 turn 内无限工具步”“多 turn 长跑”两类 §6.9 要求 100% 拦截的注入场景。
4. 没有真实 Web 页面 dock 挂载验证（client 只做源码级渲染/注册断言；与真实 slot standardProps 的对接靠人工核对）。
5. 无大输出性能基准（10MB log/JSON）、无并发多 session 压测、无 side-store 清理/TTL 测试。
6. 无 Windows/pwsh 路径、无 DSH_HOME 缺失/不可写、无 dataDir 非法路径负例。
7. 无“M1 与 spill-policy 同时开启”的交互测试（P2-11）。
8. 无 value 型 post-execute 决策的契约测试（P1-1）。

---

## 6. 验收判定

- 功能与 UI 结构：**通过**（14 条黑盒 + 71 条既有测试；真实 profile 装载成功）。
- Phase 0 账本准确性：**有条件不通过**——默认 usage 语义（P0-1）与重试采样缺口（P1-2）导致 USD 系统性偏差；修复 P0-1、P1-2、P1-6 后才满足 §8.6 Phase 0“对账偏差 ≤1%”。
- M1/M9 契约：主体符合，需先修 P1-1（value/content 冲突）与 P1-3/P1-5 生命周期/清理。
- 建议修复顺序：P0-1 → P1-1 → P1-2 → P1-3 → P1-4 → P1-6 → P1-5 → P2-6（secret 过宽，影响命中率）。
