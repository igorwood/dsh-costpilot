# CostPilot v1.0 完整实现契约（模块扩展）

在 v0.1（Phase 0 + M1 + M9 + UI pill）基础上补齐 M2–M8 与 M10，形成设计文档的完整插件族实现。
原则：默认关闭高风险模块；所有策略纯函数可测；不改 DSH 内部文件；不新增 session 事件类型（除 compaction 协议自带类型）。

## 文件归属（避免并发写冲突）

| 负责人 | 文件 |
|---|---|
| core-impl-v1 | lib/indexer.js, lib/index-tool.js, test/m4.test.mjs |
| turn-impl | lib/turn-policy.js, test/turn-policy.test.mjs |
| compaction-impl | lib/compaction-plan.js, lib/compactor.js, test/compaction.test.mjs |
| hooks-impl-v1 | lib/repeat-cache.js, lib/audit.js, test/repeat-cache.test.mjs |
| Lead | lib/config.js, index.js, lib/commands.js, lib/sim.js, client.js, lib/ledger.js（retry 采样）、test/integration.test.mjs、文档 |

## A. M4 跨会话索引（core-impl-v1）

`lib/indexer.js`：
```
createIndex({ root, dbPath, config, logger }) -> {
  ensureFresh(): { built, files, entries, builtAt, stale? }
  query(sql): { columns: string[], rows: unknown[][], ms, truncated: boolean }
  markDirty(paths?: string[]): void          // 供 fs/observed
  stats(): { files, entries, builtAt, root, dbPath, dirty: number }
  close(): void
}
```
- 存储：`node:sqlite` 的 `DatabaseSync`；只读查询用 `readOnly: true` 的连接（或打开后仅 prepare SELECT）。
- 表：`files(path PRIMARY KEY, name, language, lines, mtime, size)`；`entries(path, name, kind, parent, line_start, line_end, meta)`；`meta(key,value)`（schema_version=1, root, built_at）。
- 遍历：node:fs 递归；忽略 config.ignoreDirs / exclude 通配 / >maxFileBytes / 二进制；最多 maxFiles。
- 提取：TS/JS（import/export/class/function/interface/type）、Python（def/class）、Go（func/type/method）、Markdown（标题）、兜底 TODO/FIXME；行号 1-based。
- 增量：markDirty 记录路径，ensureFresh 仅重建 dirty 文件；文件 mtime/size 变化时重建该文件；schema 版本或 root 不匹配时全量重建。
- SQL 安全：仅允许单条 SELECT；拒绝 `; -- /* */ PRAGMA ATTACH DETACH INSERT UPDATE DELETE DROP ALTER CREATE REPLACE VACUUM REINDEX load_extension`；包装为 `SELECT * FROM (<sql>) LIMIT maxRows`；异常转成 Error（message 含定位）。
- 性能：10k 文件构建 <10s；查询 p95 <100ms（测试用 ≤500 文件断言）。

`lib/index-tool.js`：
`createIndexTool({ index, config }) -> ToolDefinition`
- name `index_query`；description 含两表 schema 与示例查询、只读/行数上限说明。
- parameters JSON Schema：`{type:'object', properties:{sql:{type:'string'}}, required:['sql'], additionalProperties:false}`。
- output：`{ schema:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false}, render(args,value){ return [{type:'text',text:value.text}] } }`。
- execute(args, exec)：校验 args.sql 字符串；调用 index.query；返回 `{ text }`（紧凑表格文本，含 columns/rows/耗时/truncated）。

## B. M5/M6/M7 步骤策略（turn-impl）

`lib/turn-policy.js`（纯函数，无 IO）：
```
createBatchingNudge({ config }) -> {
  plan({ turn, step, callsPerTurn, recentToolNames, phase }) -> { inject: true, text } | null,
  noteInjected(), shouldDisable({ after: { callsPerTurn, costDelta } }) -> boolean
}
createToolsetScheduler({ config }) -> {
  plan({ step, phase, tools: [{name, schemaTokens}] , remainingSteps }) ->
    { deny: string[], schemaTokensSaved: number, netUSD: number } | null,
  noteSwitch(), noteUnknownTool(name), shouldRestore(name) -> boolean
}
createRouteSelector({ config }) -> {
  plan({ phase, remainingSteps, currentRoute }) -> { provider, model } | null,
  noteSwitch(), switches()
}
```
- M5 文案用设计附录 C 的收敛版（≤140 token），仅在 turn<=firstTurns 或连续单工具调用时建议；maxInjections 生效；adaptive 时由 noteInjected/shouldDisable 控制。
- M6 用 `hideCandidates` 前缀匹配 + 不在 keep 列表、且 schemaTokens ≥ 300 才建议；每 session maxSwitches；纯函数输出 deny 列，由 Lead 在 pre-step 用 `agent.ctx.tools.restrict` 应用（下一步生效）。
- M7 仅在允许 phase、remainingSteps≥min、且与当前 route 不同、未超 maxSwitches 时返回目标 route。

## C. M2/M3 压缩器（compaction-impl）

`lib/compaction-plan.js`：
```
createCompactionPlanner({ config }) -> {
  plan(input) -> {
    module: 'M2'|'M3',
    startSeq, endSeq,                    // inclusive surface range
    summary: string,                     // template, no LLM call
    shadowedTokenCount: number,
    deltaTokens: number,
    remainingSteps: number,
    netUSD: number
  } | null
}
```
- input: `{ session, events?: SessionEvent[], price, remainingSteps, phase, lines?: [{seq,tokens,reuseProbability}] }`
- M2：区间级 GC；规则打分（age/引用/工具类型/错误/路径/最近 K 步），mean(P)≤tau 的连续区间；保留最近 keepRecentSteps、user/error/未闭合 tool pair；单次 ≤maxRegionRatio；模板摘要（列出保留的调用签名/编辑文件/测试结论/原文 seq 范围）。
- M3：阶段分类（setup/search/read/edit/test/execute）+ 相邻同阶段段；闭合段≥segmentSteps 且总步数≥minStepsBefore 才触发；模板摘要；每 session ≤maxCompactionsPerSession。
- 必须用 `surface` 事件（user/message/assistant/message/tool/result）计算 seq 范围；tool-pairing 对齐（不切断未配对 tool call）。

`lib/compactor.js`：
```
createCompactor({ config }) -> {
  run(plan, session): Promise<{ ok: true } | { ok: false, error: string }>
}
```
- 严格按 DSH 协议（参考 dsh-compaction-basic lib/index.js 的 append 调用）：
  1. `session.append('compaction/start', { compactionId, turn })`
  2. `session.append('compaction/summary', { compactionId, shadowedRange:{startSeq,endSeq}, shadowedSeqs:[...], shadowedTokenCount, provider:null, model:null })`
  3. `session.append('user/message', checkpointMessage, { surfaceOp:{op:'replace',startSeq,endSeq}, sourceEventSeqs:[startSeq..] })`；checkpoint 消息 source.kind='compact-checkpoint'（或与 dsh-compaction 的 isCompactCheckpointSource 兼容的字段）。
  4. `session.append('compaction/end', { compactionId, turn })`；失败时 end 带 error。
- 无锁竞争检查：若 session 尾部存在未配对 compaction/start → 返回 {ok:false,error:'busy'}（不写任何事件）。
- compactionId 用确定性前缀（crypto.randomUUID 也可，但测试用注入 id 生成器）。

## D. M8 + 审计（hooks-impl-v1）

`lib/repeat-cache.js`：
```
createRepeatCache({ config }) -> {
  decide({ toolName, argsText, turn, step, lastResultSeq, lastResultPointer }) ->
    { action: 'none'|'advisory'|'deny'|'cache', text?: string, key?: string } ,
  record({ toolName, argsText, resultText, resultSeq, isError }),
  lookup(key), ttlSweep(now)
}
```
- 仅 allowTools；相同 name+canonical args；advisory 文案含结果 seq；deny 文案含指向；cache 仅记录可复用结果（供 tools/execute 实验路径）。
- canonical args：JSON.parse 后按 key 排序序列化（失败用原文 hash）。

`lib/audit.js`：
```
reconcileUsage({ ledger: {tokens:{uncachedInput,cacheRead,cacheWrite,output}}, tokenUsage }) -> {
  ok: boolean, deltas: {...}, mismatched: string[]
}
```
- tokenUsage 投影字段：uncachedInputTokens/cacheReadTokens/cacheWriteTokens/outputTokens；偏差 >2% 或 >100 token 视为 mismatch。

## 验收
- 每个负责人：`node --test test/<own>.test.mjs` 全绿；纯函数确定性；无网络。
- Lead 集成后全套 ≥140 tests；真实 profile 装载 + M4 索引文件在 workspace 下生成。

## 交付状态（2026-11-13）

| 模块 | 状态 | 测试 |
|---|---|---|
| M4 跨会话索引 | ✅ indexer/index-tool，index.js 懒注册（M4 enabled 或 /costpilot on M4） | test/m4.test.mjs 20 |
| M5/M6/M7 | ✅ turn-policy，index.js pre-step/turn-stopping 接线 | test/turn-policy.test.mjs 35 + integration-v1 |
| M2/M3 | ✅ planner+compactor，index.js pre-step 触发（builtin compaction 需显式 allow） | test/compaction.test.mjs 22 + integration-v1 |
| M8 + audit | ✅ repeat-cache/audit，index.js pre-execute/post-execute 接线 | test/repeat-cache.test.mjs 26 |
| M1/M9/账本/UI | ✅ v0.1 基础上扩展（retry 替换采样、¥、明细面板、/costpilot；M9 连续硬限/配额/进展） | 全套 216 |

已知近似：M2 暂用规则打分（GBDT 待数据）；M8 的 cache 执行路径为实验性；M2/M3 在存在内置 compaction 时需显式 allow。