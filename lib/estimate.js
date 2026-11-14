/**
 * Deterministic token estimation for dsh-costpilot. Dependency-free.
 *
 * The primary heuristic is 4 characters per token (matching DSH tokenMeter).
 * Plain 4 chars/token badly underestimates CJK and JSON, so those get a
 * conservative floor: CJK code points count as one token each and JSON
 * structural punctuation counts as one token each. Every function is pure and
 * deterministic (no clocks, no randomness) and returns a non-negative integer.
 *
 * These numbers are for counterfactuals and predictions only; provider usage
 * from assistant/message is the billing truth (design section 5.1).
 *
 * @module dsh-costpilot/lib/estimate
 */
const CHARS_PER_TOKEN = 4
const ASCII_WEIGHT = 1 / CHARS_PER_TOKEN
const OTHER_WEIGHT = 0.5
const CJK_WEIGHT = 1
const MESSAGE_ENVELOPE_TOKENS = 4
const TOOL_RESULT_ENVELOPE_TOKENS = 4
const TOOL_SCHEMA_ENVELOPE_TOKENS = 8
const IMAGE_TOKENS = 1000
const PRIOR_REMAINING_CALLS = 6
const MAX_REMAINING_CALLS = 16
const MAX_CONTEXT_TOKENS = 500000
const MAX_STEP_PRESSURE = 80
const MAX_TURN_PRESSURE = 20
const MAX_TOOL_PRESSURE = 200
const JSON_STRUCTURAL_CHARS = new Set(['{', '}', '[', ']', ',', ':', '"'])

function isCJK(cp) {
  return (cp >= 0x2e80 && cp <= 0x2fdf) ||
    (cp >= 0x3000 && cp <= 0x303f) ||
    (cp >= 0x3040 && cp <= 0x30ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xac00 && cp <= 0xd7af) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xff00 && cp <= 0xffef) ||
    cp >= 0x20000
}

function weightedLength(text, json) {
  let weight = 0
  for (const char of text) {
    const cp = char.codePointAt(0)
    if (cp <= 0x7f) {
      weight += json && JSON_STRUCTURAL_CHARS.has(char) ? 1 : ASCII_WEIGHT
    } else if (isCJK(cp)) {
      weight += CJK_WEIGHT
    } else {
      weight += OTHER_WEIGHT
    }
  }
  return weight
}

/**
 * Estimate tokens for plain text with the 4 chars/token heuristic plus CJK floors.
 * @param {unknown} text
 * @returns {number} non-negative integer
 */
export function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  return Math.max(1, Math.ceil(weightedLength(text, false)))
}

/**
 * Estimate tokens for a JSON value (or an already-serialized JSON string).
 * Structural punctuation is counted at one token each, a conservative floor.
 * @param {unknown} value
 * @returns {number} non-negative integer
 */
export function estimateJsonTokens(value) {
  let text
  if (typeof value === 'string') {
    text = value
  } else {
    try {
      text = JSON.stringify(value ?? null)
    } catch {
      return 0
    }
  }
  if (typeof text !== 'string' || text.length === 0) return 0
  return Math.max(1, Math.ceil(weightedLength(text, true)))
}

function blockTokens(block) {
  if (typeof block === 'string') return estimateTokens(block)
  if (!block || typeof block !== 'object') return 0
  switch (block.type) {
    case 'text':
      return estimateTokens(block.text)
    case 'json':
      return estimateJsonTokens(block.value ?? block.json ?? block.text ?? block)
    case 'image':
      return IMAGE_TOKENS
    case 'tool_use':
      return 2 + estimateTokens(typeof block.name === 'string' ? block.name : '') +
        estimateJsonTokens(block.input ?? block.arguments ?? {})
    case 'tool_result':
      return 2 + contentTokens(block.content)
    default:
      return typeof block.text === 'string' ? estimateTokens(block.text) : 0
  }
}

function contentTokens(content) {
  if (typeof content === 'string') return estimateTokens(content)
  if (Array.isArray(content)) {
    let total = 0
    for (const block of content) total += blockTokens(block)
    return total
  }
  if (content && typeof content === 'object') {
    if (typeof content.text === 'string') return estimateTokens(content.text)
    return estimateJsonTokens(content)
  }
  return 0
}

/**
 * Estimate the model-visible tokens of one chat message.
 * @param {{role?: string, content?: unknown}} message
 * @returns {number} non-negative integer
 */
export function estimateMessage(message) {
  if (!message || typeof message !== 'object') return 0
  const roleTokens = typeof message.role === 'string' ? estimateTokens(message.role) : 0
  return Math.max(1, Math.ceil(MESSAGE_ENVELOPE_TOKENS + roleTokens + contentTokens(message.content)))
}

/**
 * Estimate the model-visible tokens of a tool result (content blocks or text).
 * @param {unknown} contentBlocks array of content blocks, a string, or a message-like object
 * @returns {number} non-negative integer
 */
export function estimateToolResult(contentBlocks) {
  if (contentBlocks === undefined || contentBlocks === null) return 0
  const content = (typeof contentBlocks === 'object' && !Array.isArray(contentBlocks) && 'content' in contentBlocks)
    ? contentBlocks.content
    : contentBlocks
  return Math.max(1, Math.ceil(TOOL_RESULT_ENVELOPE_TOKENS + contentTokens(content)))
}

/**
 * Estimate the tokens a tool schema permanently costs in the prompt prefix.
 * @param {{name?: string, description?: string, parameters?: unknown}} schema
 * @returns {number} non-negative integer
 */
export function estimateToolSchema(schema) {
  if (!schema || typeof schema !== 'object') return 0
  const nameTokens = estimateTokens(schema.name)
  const descriptionTokens = estimateTokens(schema.description)
  const parameterTokens = estimateJsonTokens(schema.parameters ?? {})
  return Math.max(1, Math.ceil(TOOL_SCHEMA_ENVELOPE_TOKENS + nameTokens + descriptionTokens + parameterTokens))
}

function nonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

/**
 * Bounded heuristic for the number of remaining LLM calls (N-hat) in a session.
 *
 * Prior is 6 calls (design section 5.2.2). Progress (turn/step/tool pressure)
 * reduces the estimate; a large context raises it (long-context tasks keep
 * going). The result is always an integer in [1, 16].
 *
 * @param {{turn?: number, step?: number, toolCalls?: number, contextTokens?: number}} [progress]
 * @returns {number} integer in [1, 16]
 */
export function estimateRemainingSteps(progress = {}) {
  const turn = nonNegative(progress.turn)
  const step = nonNegative(progress.step)
  const toolCalls = nonNegative(progress.toolCalls)
  const contextTokens = nonNegative(progress.contextTokens)

  const turnPressure = Math.min(Math.max(turn - 1, 0), MAX_TURN_PRESSURE) / MAX_TURN_PRESSURE
  const stepPressure = Math.min(Math.max(step - 1, 0), MAX_STEP_PRESSURE) / MAX_STEP_PRESSURE
  const toolPressure = Math.min(toolCalls, MAX_TOOL_PRESSURE) / MAX_TOOL_PRESSURE
  const contextBonus = Math.min(contextTokens, MAX_CONTEXT_TOKENS) / MAX_CONTEXT_TOKENS

  const raw = PRIOR_REMAINING_CALLS -
    2 * turnPressure -
    2 * stepPressure -
    1 * toolPressure +
    6 * contextBonus
  return clamp(Math.round(raw), 1, MAX_REMAINING_CALLS)
}
