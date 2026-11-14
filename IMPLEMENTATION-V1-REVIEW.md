# dsh-costpilot v1.0 独立验收与接线评审

- 验收人：acceptance-verifier（独立于实现）
- 覆盖：Phase 0 账本 + M1–M9 + /cost、/costpilot + projection/client + sim
- 证据：IMPLEMENTATION-v1.md、README.md、index.js、lib/*.js、test/mock-ctx.mjs；并用 DSH 0.2.2-rc.1 运行时包（app.asar 内 dsh-tools / dsh-agent / dsh-agent-loop / dsh-session / dsh-compaction / dsh-compaction-basic 等）核对宿主契约
- 结论：**黑盒验收 14/14 通过；全套 214/214 通过；模块策略主体正确，但 index.js 接线有 2 个 P0 与 9 个 P1，多数表现为“默认配置下静默不生效/静默失效”，不会崩溃但会让模块声明与实际行为不一致。**

---

## 1. 验收测试

新增 test/acceptance-v1.test.mjs（node:test，14 条，全绿），只驱动 index.js / lib/projection.js / lib/sim.js / client.js + test/mock-ctx.mjs：

1. M2 pre-step 走完整 compaction 协议（start/summary/replace user-message/end 的 id、shadowedRange、sourceEventSeqs 对齐）+ 账本 M2 mutation
2. M2 在内置 compaction 服务存在且未显式 allow 时不写任何 compaction 事件（gating）
3. M4 index_query 建索引、忽略 ignoreDirs、import/function 提取、拒绝写 SQL/多语句/PRAGMA、db 落在 workspace 根
4. M4 同 workspace 第二个 session 复用同一 index.db
5. M5 注入批处理 nudge，maxInjections 封顶
6. M6 restrict 大 schema 候选、keep/run_code 不动、guard 记录 toolset-switch
7. M7 在 turn-stopping 调 agent.model.select 降到便宜 route，maxSwitches 封顶
8. M8 deny 相同 read 重复调用，reason 含 previous result/Reuse，guard 记录 repeat-call
9. M9 预算超限只 warn（带 [costpilot:guard ...] marker），默认不 cancel
10. /costpilot status、on M4（运行时注册 index_query）、off M4（注销）、simulate（¥ 与 M1 节省）、非法子命令报错
11. ¥ 货币：/cost、sim renderReport、client pill 三处一致
12. projection 折叠 cost/M1 marker/M9 marker，modules getter 实时反映开关
13. 账本采样 assistant/attempt + llm/retry-started 的替换增量（重试计费）
14. turn-end tokenUsage 对账不一致时写 guard 审计事件

运行：cd dsh-costpilot && node --test test/*.test.mjs → tests 214 / pass 214 / fail 0。

---

## 2. 已核对通过的宿主契约

- tools/post-execute (exec, result, next) → {kind:'accept', content|value, additionalContexts}；value/content 互斥（dsh-tools/lib/pipeline.js）
- tools/pre-execute → {kind:'allow'|'deny'|'ask'|'cancel'}；deny.reason 为错误文本
- agent/pre-step payload 含 {agent,messages,turn,step,signal,modelSelection}；decision {kind:'enter'|'reject'}
- agent/turn-stopping 事件签名 {agent,turn,signal}；agent.steer/inject/cancel(cause,{keepInbox})；agent.model.select(route)（下一步生效）；
- agent.ctx 是 scoped context；tools.restrict 必须经 agent.ctx（全局调用会抛错），且不得含 run_code / 未知工具名
- ctx.tools.definitions(scope)/schemas(scope)；ctx.get() 存在；ctx.sessionProjections.register({key,stateVersion,init,apply,wire})
- session.header.cwd 是合法的绝对 workspace 路径（dsh-session 校验）；compaction/start|summary|end 与 surfaceOp replace + source.kind='compact-checkpoint' 的 checkpoint 语义与 dsh-compaction-basic 一致
- 客户端 window.__ModuleLoader__.load({id,factory}) + inject:['slots'] + conversation.composer.dock 的 standardProps 含 useProjection

---

## 3. P0

**P0-1 M2/M3 没有净收益门控（netUSD > 0），可把会话改贵，直接违背设计核心判据。**
- 位置：lib/compaction-plan.js:560-597（planM2）、613-666（planM3）只在 deltaTokens>0 时返回 plan，netUSD 仅计算不判决；index.js:420-436 无条件执行 plan。
- 依据：design §5.2/§6.1/§8.6 要求 S>0（含 (p_w−p_r)·suffix 重写成本）才允许动作；M2/M3 默认关闭，但一旦在 assist 下开启（或 /costpilot on M2）就会在 warm cache + 大 suffix 时净亏。
- 影响：本插件的唯一目的是降本，此处可能系统性增本；且无 calibration_error 记录。
- 修复：index.js 在 run(plan) 前检查 plan.netUSD > minNetUSD（默认 0 或按 mode），否则只记录 defer；并把 plan 的输入（N、suffix、tau）写入账本/审计。

**P0-2 允许与内置 compaction 共存时，M2/M3 绕过了唯一写者锁。**
- 位置：index.js:409-414（builtin = ctx.get('compaction')，allowWithBuiltin 直接放行）→ lib/compactor.js:271-343（直接 session.append 四条事件，仅用 inspectState 扫日志尾部判断 busy）。
- 依据：design §5.4 I1（同一 session surface 改写串行，必须共享 compaction 锁）；dsh-compaction-basic 的锁在 CompactionEngine 内存态，不等价于日志里出现 unmatched compaction/start。
- 影响：显式 opt-in allowWithBuiltinCompaction=true 后与 dsh-compaction-basic 并发改写同一 surface → 替换区间失效、日志损坏风险（数据丢失级别）。
- 修复：M2/M3 只允许在“替换 compaction backend”或“无 ctx.compaction”时工作；若要共存必须通过 ctx.compaction 的 API/锁，或至少在 append 前 await 官方 idle/lock 校验。

---

## 4. P1

**P1-1 fs/observed 监听签名错误，M4 索引永不增量失效。**
- 位置：index.js:506-513。DSH 实际签名是 (target, observation, actor)（见 dsh-fs-observation-policy/lib/index.js:100、dsh-api-workspace-files:18）；当前只读第一个参数 payload.paths，永远得到 []。
- 影响：markDirty([]) 不标记任何文件，mtime 校验（lib/indexer.js:591-735）之外依赖 dirty 的增量路径基本失效；编辑后 index_query 继续返回旧符号（检索型任务准确率风险）。
- 修复：改为 ctx.on('fs/observed', (target, observation) => { 提取 target/observation.path 并 markDirty；只标对应 workspace 的 index })。

**P1-2 tokenUsage 对账使用已废弃 API + 伪造 session，生产环境会静默失效。**
- 位置：index.js:213-226。registry.stateOf(session,key) 在 dsh-session-projection 中已标记 deprecated，签名需要真实 Session；这里传 {id: sessionId}，真实实现会取不到 cell（或抛错被 catch）。
- 影响：Phase 0 的“账本 vs tokenUsage 偏差 ≤1%”门禁实际上只在 mock 下工作（验收测试用 MockProjectionRegistry 才通过）。
- 修复：在 session/event 的 turn/end 分支把真实 session 传入 reconcile；或注册时保留 handle（registration 的 stateOf(session)）并优先用它；或改为 ctx.inject(['tokenMeter'])。

**P1-3 /costpilot on M5/M6/M7/M8 对已存在会话不生效，命令却报成功。**
- 位置：index.js:151-169（stateFor 时用当前 config 快照构造 nudge/scheduler/router/repeat），index.js:546-553（setModuleEnabled 只改 runtime 并特殊处理 M4）。
- 依据：lib/turn-policy.js:100-111、lib/repeat-cache.js:55-85 在构造时 spread 出 enabled/level 等值；之后 isActive(runtime) 为 true 会调用 plan()，但实例内部 enabled=false → 全部返回 null/action none。
- 影响：“开”是假动作（只有“关”和 M4 真正生效）；用户看到成功文案。
- 修复：策略实例按需惰性创建（在 plan 时用 runtime 构造），或 setModuleEnabled 时销毁并重建 state 上的策略实例；命令文案只报告实际生效的模块。

**P1-4 M1 压缩时跳过 M8 记录，M1 开启后 M8 永不触发。**
- 位置：index.js:258（M1 非 active 才 recordRepeat）、270、301（压缩成功直接 return，未 recordRepeat）、306（异常兜底才记录）。
- 依据：design §6.10 “M8 + M1：先 M8 判定，再 M1 处理 miss”；v1 场景下 M1 与 M8 都是默认关闭但常在 assist 同时开启，大输出（最需要 M8 的）恰好被 M1 拦截而不入缓存。
- 修复：把 recordRepeat 移到压缩分支之前/之后统一执行（用压缩前原文或结果均可），保证无论 M1 是否改写都 record。

**P1-5 M6 的 UNKNOWN_TOOL 恢复路径未接线，隐藏工具永不恢复。**
- 位置：index.js:448-472 只调用 plan()/restrict()/noteSwitch()；lib/turn-policy.js:298-307 的 noteUnknownTool/shouldRestore 全库无调用者。（grep 可证）
- 影响：与 design §6.6 的“模型请求被隐藏工具 → 立即恢复并记录误判”不符；一旦误隐藏，整个 session 都不可用该工具（只能等 3 次 switch 预算之外无补偿）。
- 修复：监听工具不存在/UNKNOWN_TOOL 信号（或 pre-execute 未知工具路径），调用 noteUnknownTool 并把对应 deny 从 restrict 层撤销（restrict 返回的 disposer 需要保存）。

**P1-6 M5 注入时机与触发条件都不成立，且污染 guard 计数。**
- 位置：index.js:389-403。用 agent.steer()（DSH 语义是“next-step”输入）而非 design §6.5 的当前步 user/message；state.recentToolNames 从未赋值（只读于 index.js:394），callsThisTurn 只在 turn 内累计且 turn/start 清零（193-199），所以“连续单调用”分支不可达；shouldDisable（自适应自动关闭）全库未调用（lib/turn-policy.js:207-224）。
- 影响：M5 实际只在 turn<=firstTurns 时注入，且晚一步生效；无法自动关闭；注入被 recordGuard(WARN) 记为 guard 告警，dock 的 !N 与 /costpilot 指标把 nudge/toolset/route-down/audit 混入 M9 告警（index.js:401/466/496/222）。
- 修复：注入进 pre-step decision.messages（本步生效）或明确接受 steer 语义并改文档；补 recentToolNames 环形缓冲；在 turn/end 调 shouldDisable；模块开火改用独立 metric 而不是 guard action。

**P1-7 /cost 仍优先读进程内 live summary，resume/后挂载后少报历史成本。**
- 位置：index.js:528-534（getSummary 有数据就返回，不 merge store），lib/commands.js:65。与 v0.1 同样的问题，v1 未修。
- 修复：始终 summarizeStore(storeDir, sessionId) 与 live tail 合并（按 seq 去重），或插件在 session/created 时回灌账本。

**P1-8 observe 模式不记录任何模块决策（M2–M8），违背 README/design 的“只记录决策”。**
- 位置：index.js:367/389/407/448/486 全部先 isActive()（observe 返回 false）→ 直接跳过；design §5.2 observe 用于校准，Phase 0 期望有 verdict 记录。v1 只有 M9 的 observe 也无记录。
- 影响：默认 mode=observe 下模块“空转”且没有决策日志，无法做 Phase 0 的影子决策分析（experiments.shadowPercent 语义缺失）。
- 修复：每个模块增加 observe 分支：调用 plan/decide 但不执行副作用，recordGuard/recordDecision 记录 predicted netUSD/原因。

**P1-9 M2/M3 的触发节流在失败/跳过时也消费节流窗口。**
- 位置：index.js:414-415 在 plan/run 之前就写 lastCompactionAttempt。计划为空、compactor busy、observer 异常都会导致 3 步内不再尝试。
- 修复：仅在 run ok 或明确成功后再更新；不同 reason 分开记录。

---

## 5. P2

1. **allowWithBuiltinCompaction 跨模块 OR 合并**（index.js:411-412）：M2 的 flag 会放行 M3，反之亦然；应按实际待执行模块分别判断。
2. **hardStopSteps / subagentLimit / taskUSD 是死配置**：config.js:116/118/41 定义，guard.js 的 M9_KEYS（30-36）不含 hardStopSteps，无连续 N 步硬停；subagentLimit 无任何 subagent 计费/deny 实现；README 的 budgets.taskUSD 不参与校验。设计 §6.9 的信号（子代理膨胀、高成本工具滥用、连续 2 步硬限）未实现。
3. **M9 仍是 turn-centric 旧守卫**：guard.js 的 no-progress 只看相同工具签名，不含 workspace 变更（design §6.9）；step 单位实现了但没有前文/后文确认。v1 文档不该暗示 §6.9 全量完成。
4. **M2/M3 的 N̂ 是硬编码 16-step**（index.js:423、459；M7 的 remainingSteps 固定 12，index.js:489），未用 lib/oracle.js 的 Eq.2 预测器，与 §5.2/§6.1 的公式门控不一致。
5. **M2/M3 mutation 记账口径**：index.js:429-435 用 shadowedTokenCount 记为 removedTokens、summary 估值记为 addedTokens；sim 把所有模块的 removedTokens 汇总成 m1_removed（lib/sim.js:119-133），仪表盘会把 M2/M3 误标为 M1；/costpilot simulate 也叫 M1。
6. **guard 事件 action 复用 WARN**（index.js:222/342/401/466/496）：审计/去重/批处理/工具集/路由全部计成 guard warning；§8.1 的开火率无法按模块归因，dock 的 !N 语义失真。
7. **M4 生命周期与性能**：indexes Map 只增不 close（index.js:90/98-112，dispose 只 flushAll）；fs/observed 会 markDirty 所有 workspace（509-511）；首次 query 同步构建索引（indexer.js:705）会阻塞工具调用，10k 文件超时预算未测；queryTimeoutMs 配置未被使用（仅有 busy_timeout，indexer.js:475）；SQL_FORBIDDEN 的 replace 会误杀 SQLite replace() 函数。
8. **M8 缓存无清扫 + 指针文案不实**：ttlSweep 无调用者（repeat-cache.js:253-264），entries 只在 lookup/decide 时惰性过期；record 存完整 resultText（可能很大）→ 会话内存增长；recordRepeat 的 pointer 是 'call:<id>'、resultSeq undefined（index.js:311-321），deny/advisory 文案出现 “previous result at seq unknown; side-store: call:r1”，不是可用指针。
9. **M5/M6/M7/M8 观察/决策未落账本**：除 guard 事件外没有 decision_log，observe 校准、预测误差、defer 比例都无法统计（§5.5/§8.1）。
10. **state.audit 与 injectedNudges 死字段**：index.js:161/165，audit 结果从不进入 /costpilot status、dock 或账本汇总；injectedNudges 从未使用。
11. **pruneSideStore 在 apply 内同步递归删除**（index.js:52-68）：数据大时阻塞激活；且删除后 M1 压缩文本里的 “full output saved to <path>” 指针不会失效/标记，违反 §6.1 指针可解析红线。
12. **client 半**：CSS 仍在 factory 执行期注入且无清理（client.js:37-44，DSH UI 插件规范要求 factory 无副作用、apply 内 ctx.effect 注册）；Tooltip onlyWhenClipped:false 与 sibling 的 true 不一致；面板用 window.innerHeight 定位，无右侧夹取。面板 portal 到 body 符合 composer dock 的 fixed overlay 要求。
13. **projection 的 mode 静态、modules 动态**：createCostProjectionDefinition 在注册时捕获 mode（projection.js:118），/costpilot 只能改模块；/costpilot 切换后 mode 不会变（当前无 mode 命令，可接受）；projection 不折叠 M2/M3（无 marker），dock 无法展示 M2/M3 效果。
14. **/costpilot on all 会一次打开 M2/M3**（commands.js:100-103），两者是高风险历史改写模块；建议 all 只包含低风险模块或二次确认。
15. **M2/M3 计划成本**：planner 每次 pre-step 都 buildContext 全量折叠会话事件（compaction-plan.js:683-693），大 session 在“每 3 步尝试”下是 O(n) 扫描；可缓存 surface 版本。
16. **M2/M3 的 checkpoint 协议细节**：compactor 写的 compaction/summary 不含 provider/model/usage（null），compaction/end 无 reason；对模板摘要可接受，但审计无法归因；summary 与 <compacted-summary> 包裹格式需与 dsh-compaction-basic 的 consumer 约定一致（真实 session 未做回放验证）。
17. **M4 的 index_query 是全局注册工具**（index.js:115-134），schema 常驻所有 agent；M4 关闭时靠 /costpilot off 注销，若进程重启后配置仍 enabled=false 则不会注册（正常），但 README 的“默认关闭”与工具发现成本需要 phase 说明。

---

## 6. 测试缺口

1. 全部为 mock-ctx 黑盒：未跑真实 DSH Session（append 校验、surface replace、compaction 锁、tokenUsage 投影、tools.restrict scope、fs/observed 签名）。P0-2/P1-1/P1-2 正是只有真实运行时才暴露的问题。
2. M2/M3 没有回放/损坏测试：surface 替换后 deriveMessages、resume、fork、与内置 compaction 并发、busy 时的 no-op。
3. M4 无大仓库（5k–10k 文件）构建时间/查询 p95、无 mtime 变更后的 stale 检测（fs/observed 接线缺陷未被覆盖）、无 queryTimeout。
4. M5 无“注入后 calls/turn 未升 → 自动关闭”的接线测试；M6 无 UNKNOWN_TOOL 恢复测试；M7 无真实 route 变化后的缓存成本测试。
5. M8 无与 M1 同时开启的交互测试、无 TTL/内存上限、无 cache 级别的 tools/execute 实验路径（README 声明实验性）。
6. 无 observe 模式决策记录测试（因为实现没有），无 audit 在真实 registry 下的测试。
7. 客户端无真实 Web 页面验证（panel 打开/关闭、Esc/外点、portal 定位、CNY 显示仅源码级）。
8. 无 profile 真实装载回归（v0.1 已做过一次；v1 增加 index_query 工具与 compaction 写入，需要重新做一次 boot/dump-config/一次真实 session）。

---

## 7. 结论与建议顺序

- 黑盒功能验收：**通过**（14/14；全套 214/214），模块策略、协议、命令、金额、projection、客户端结构均符合声明。
- 接线可发布性：**有条件通过**。建议修复顺序：
  1. P0-1（净收益门控）——成本插件不能有增本路径；
  2. P0-2（compaction 唯一写者）——历史改写数据安全；
  3. P1-1（fs/observed）、P1-2（tokenUsage 对账）、P1-3（运行时 on）、P1-4（M1/M8 顺序）
  4. P1-5（M6 恢复）、P1-6（M5 语义与指标）、P1-8（observe 决策记录）、P1-7/P1-9
  5. 再补真实运行时回归（Session append / compaction lock / tokenUsage / fs/observed / tools.restrict scope）。
