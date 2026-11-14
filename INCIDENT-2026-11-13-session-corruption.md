# 事故记录：CostPilot guard 消息损坏会话（2026-11-13）

## 现象

四个 DSH 会话在继续对话时出现两类错误，且互相牵连：

1. 历史加载失败：
   `stored session "session-43d3c88c-…" is corrupt: … session event at seq 4981 lacks an identified message (gateway/internal)`
2. 请求被网关拒绝：
   `Failed to deserialize the JSON body into the target type: messages[N]: missing field \`role\``
   （`request_id` 8f0852ab / e0e49a7a / 78e7aea6 / 69e2b9d0）
3. 同一会话再次打开时，第 1 条的损坏会让整个会话无法加载。

## 根因

CostPilot 在 `mode: assist` 下，M9 预算守卫（`maxTurnCostUSD`）触发时会调用：

```js
agent.steer({ content: [...], source: { kind: 'costpilot' } })
```

`agent.steer()` / `agent.inject()` 不会补全消息，而是把参数原样放进 inbox，agent-loop 随后把它作为
`user/message` surface 事件写入会话。DSH 在加载会话时校验该事件必须是完整消息：

- 非空字符串 `id`
- `role: 'user'`
- 非空 `source.kind`
- 数组 `content`

裸 `{ content, source }` 只通过了宽松的 inbox schema，因此：

- 事件被持久化，但加载时抛 `lacks an identified message` → 整个会话报 corrupt；
- 构造模型请求时该条消息没有 `role`，JSON 序列化丢掉 `undefined` 字段 → 网关 422
  `missing field 'role'`。

受影响的正是 M9 的 `[costpilot:guard action=warn reason=turn-cost]` 消息（M5 nudge、M8 advisory 走同一路径）。
M1 只替换工具结果 content，不写消息，未受影响。

## 证据（修复前）

| 会话 | 坏事件 | 后续请求错误 |
|---|---|---|
| `session-43d3c88c-…` | `seq 4981` user/message，缺 id/role | `messages[790]`，request_id 69e2b9d0 |
| `session-147e79df-…` | `seq 458`（同一条 steer 文本） | `messages[87]`，request_id 8f0852ab |
| `session-070ca99c-…` | `seq 434`（同一条 steer 文本） | `messages[73]`，request_id e0e49a7a |

坏事件样例：

```json
{"type":"user/message","seq":4981,"data":{"content":[{"type":"text","text":"[costpilot:guard action=warn reason=turn-cost] …"}],"source":{"kind":"costpilot"}},"surfaceOp":"append"}
```

## 修复

### 1. 立刻降级为 observe

`~/.dsh/profiles/desktop/cordis.patch.yml`：

```yaml
- id: costpilot
  config:
    mode: observe
```

`mode: observe` 下 `isActive()` 对所有模块返回 false，不再 steer/inject/改写历史。

### 2. 插件代码（lib/messages.js + index.js）

新增 `createUserNotice()`，按 DSH `createUserMessage` 的契约生成完整消息：

```js
{ id: randomUUID(), role: 'user', content, source }
```

三处 inbox 写入全部改用该 helper：

- M9 预算/失控告警 steer
- M5 批处理提示 steer
- M8 重复调用 advisory inject

### 3. 数据修复

对 3 个会话的坏 `user/message` 事件原地补 `id`（新 UUID）与 `role: 'user'`，其余事件逐字节不变；
原文件保留为 `session.v4.jsonl.zstd.bak-costpilot-repair-<ts>`。

**关键：必须保留 DSH 的多帧 zstd 布局。** DSH 的 `readFirstZstdLine` / `assertZstdHeaderFrame`
要求第一帧解压后**恰好只有一行 header**（`assertZstdHeaderFrame`：唯一换行必须在末尾）。
第一次修复把整个文件重压缩成单帧，虽然普通 `zstdDecompress` 能读，但 `listArtifacts()` 会把
这三个会话当成 corrupt 直接跳过，于是 AgentOptimization 工作区在 UI 里"会话全部消失"。

正确做法：解析原文件的帧边界，只重新压缩包含坏事件的那一帧（带 checksum），
header 帧与其余帧保留原始字节。修复后帧数不变（156/190/1747），第一帧仍然是单行 header，
逐行对比只有目标事件多出 `id`/`role`。

### 4. 验证

- 按 DSH `assertMessageEventShape` 的完整不变量 + 首帧 header 布局扫描全部会话：0 问题。
- 修复前后逐行对比：每个会话仅目标事件多出 `id`/`role`，其余 100% 相同；帧数不变。
- 重启 DSH 后三个会话均被成功读出（投影缓存更新），并各追加一帧 `session/end-seed`；证明列表与历史加载恢复。
- `node --test test/*.test.mjs`：新增 3 个消息契约测试通过（216 pass；3 个既有 client Tooltip 渲染断言失败，与本次无关）。

## 复盘：为什么修复后会话列表会"全部消失"

DSH 的会话列表对每个会话调用 `readFirstZstdLine()`，它只扫描并解压**第一帧**，然后执行
`assertZstdHeaderFrame()`：

```js
if (plaintext.length === 0 || plaintext.indexOf(10) !== plaintext.length - 1)
  throw new Error('corrupt Zstandard session log: first frame is not exactly one header line')
```

单帧文件的首帧包含 header + 全部事件，必然触发该错误；`listArtifacts()` 捕获
`SessionPersistenceCorruptionError` 后返回 `metadata: undefined`，该会话被静默跳过。
三个主会话都被跳过，工作区列表因此为空。

教训：改 DSH 会话文件时，**“能解压”不等于“DSH 能读”**。持久化层还依赖帧的物理布局。

## 恢复步骤

1. 重启 DeepSeek Harness（会话和列表可能已被缓存在内存中）。
2. 重新打开 AgentOptimization 工作区，确认 3 个会话恢复显示；打开受影响的会话确认历史正常。
3. 确认无问题后可将 `mode` 调回 `assist`；插件已不会再写畸形消息。

## 预防

- 任何 `agent.steer()` / `agent.inject()` 的入参都必须经过 `createUserNotice()`。
- 插件写入的 `user/message` / `assistant/message` / `tool/result` 事件在写入前应满足 DSH 的
  `assertMessageEventShape`；测试 `test/messages.test.mjs` 与 M5/M8/M9 验收用例已固定该契约。
- 会话加载报 `lacks an identified message` 时，先查 `user/message` 事件的 `data.id` / `data.role`。
