/**
 * M1: deterministic tool-output compaction ("Tool Output Compaction+").
 *
 * The compaction happens in the tools/post-execute replacement slot, i.e. BEFORE
 * the result is committed to the session log. That is why this module never
 * writes compaction/prune shadow events: the compacted content is the logged
 * content. The original is written to a side-store by `writeSideStore()` and a
 * pointer (path + "read it to recover") may be appended to the compacted text.
 *
 * Pure ESM, zero runtime dependencies. `compressToolResult()` is a pure
 * function: the same input and context always produce exactly the same output.
 *
 * @module dsh-costpilot/lib/compress
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

/** Estimation constant shared with lib/estimate.js (4 chars per token). */
export const CHARS_PER_TOKEN = 4

/** Text matching this is never compacted (privacy red line; design §6.1). */
export const SECRET_PATTERN = /secret|password|token|api[_-]?key|BEGIN .*PRIVATE KEY/i

const DEFAULT_M1 = Object.freeze({
  enabled: true,
  minDeltaTokens: 400,
  sideStore: true,
  formats: Object.freeze({ log: true, json: true, diff: true, table: true, code: true }),
})

const LIMITS = Object.freeze({
  headLines: 20,
  tailLines: 20,
  logHeadLines: 15,
  logTailLines: 15,
  logMaxErrorLines: 40,
  diffContext: 3,
  tableRows: 12,
  jsonArrayItems: 8,
  jsonExtraErrorItems: 4,
  jsonStringChars: 2048,
  jsonDepth: 8,
  codeLineChars: 500,
  codeHeadLines: 80,
  codeTailLines: 80,
  maxLineChars: 2000,
})

const ANSI_PATTERN = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*?(?:\u0007|\u001b\\)|[@-Z\\-_])/g
const CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g
const ISO_TIMESTAMP_PATTERN = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/
const LOG_LEVEL_PATTERN = /\b(?:TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|CRITICAL)\b/
const LOG_ERROR_PATTERN = /error|warn|fail|panic|traceback|exception|fatal|assert/i
const CODE_LINE_PATTERN = /^\s*(?:import\b|export\b|from\b|const\b|let\b|var\b|function\b|class\b|def\b|async\b|await\b|return\b|if\b|for\b|while\b|switch\b|case\b|try\b|catch\b|throw\b|public\b|private\b|static\b|#include\b|#define\b|\/\/|\/\*|\*|\}|\{|\}|\)|\])/

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 4 chars/token heuristic used for every threshold in M1. */
export function estimateTokens(text) {
  return typeof text === 'string' && text.length > 0 ? Math.ceil(text.length / CHARS_PER_TOKEN) : 0
}

/** Resolve M1 config from a full resolved config or from a bare M1 slice. */
function pickM1(config) {
  if (!isObject(config)) return { ...DEFAULT_M1, formats: { ...DEFAULT_M1.formats } }
  const modules = isObject(config.modules) ? config.modules : null
  const slice = modules && isObject(modules.M1)
    ? modules.M1
    : isObject(config.M1)
      ? config.M1
      : (!('modules' in config) && !('budgets' in config) &&
          ('minDeltaTokens' in config || 'formats' in config || 'sideStore' in config || 'enabled' in config))
        ? config
        : {}
  const merged = { ...DEFAULT_M1, formats: { ...DEFAULT_M1.formats } }
  for (const [key, value] of Object.entries(slice)) {
    if (value !== undefined) merged[key] = key === 'formats' && isObject(value) ? { ...DEFAULT_M1.formats, ...value } : value
  }
  return merged
}

/** Remove BOM, ANSI escapes, control chars, progress-bar carriage-return overwrites, CRLF. */
export function normalizeText(input) {
  if (typeof input !== 'string' || input.length === 0) return ''
  let text = input
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  text = text.replace(ANSI_PATTERN, '')
  // Collapse progress-bar overstrikes BEFORE touching CRLF: the last non-empty
  // carriage-return segment of a physical line wins (also strips the CR of CRLF).
  if (text.includes('\r')) {
    text = text.split('\n').map((line) => {
      if (!line.includes('\r')) return line
      const parts = line.split('\r')
      let kept = ''
      for (const part of parts) if (part.length > 0) kept = part
      return kept
    }).join('\n')
  }
  text = text.replace(/\r\n?/g, '\n')
  text = text.replace(CONTROL_PATTERN, '')
  return text
}

function truncateLongLine(line, max = LIMITS.maxLineChars) {
  if (typeof line !== 'string' || line.length <= max) return line
  return line.slice(0, max) + `…[+${line.length - max} chars]`
}

function normalizeLogLine(line) {
  return line
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,6})?(?:Z|[+-]\d{2}:?\d{2})?\b/g, '<ts>')
    .replace(/\b\d{2}:\d{2}:\d{2}(?:[.,]\d{1,6})?\b/g, '<time>')
    .replace(/\b(?:pid|PID)\b\s*[=:]?\s*\d+\b/g, 'pid=<pid>')
}

function looksLikeDiff(text, lines) {
  if (/^diff --git /m.test(text)) return true
  return lines.some((line) => /^@@ .*@@/.test(line))
}

function looksLikeLog(lines) {
  const sample = lines.filter((line) => line.trim().length > 0).slice(0, 400)
  if (sample.length === 0) return false
  let hits = 0
  for (const line of sample) {
    if (LOG_LEVEL_PATTERN.test(line) || ISO_TIMESTAMP_PATTERN.test(line) ||
        /^\s+at\s+\S+/.test(line) || /^Traceback \(most recent call last\)/.test(line)) hits += 1
  }
  return hits / sample.length >= 0.3
}

function detectTableDelimiter(lines) {
  const rows = lines.filter((line) => line.trim().length > 0)
  if (rows.length < 2) return null
  const tabRows = rows.filter((line) => line.includes('\t')).length
  if (tabRows >= 2 && tabRows >= Math.ceil(rows.length * 0.6)) return 'tab'
  const pipeRows = rows.filter((line) => /^\s*\|.*\|\s*$/.test(line)).length
  if (pipeRows >= 2 && pipeRows >= Math.ceil(rows.length * 0.6)) return 'pipe'
  const alignedRows = rows.filter((line) => /\S\s{2,}\S/.test(line)).length
  if (alignedRows >= 3 && alignedRows >= Math.ceil(rows.length * 0.6)) return 'space'
  return null
}

function looksLikeTable(lines) {
  return detectTableDelimiter(lines) !== null
}

function looksLikeCode(lines) {
  if (lines.some((line) => line.length > LIMITS.codeLineChars)) return true
  const sample = lines.filter((line) => line.trim().length > 0).slice(0, 400)
  if (sample.length < 3) return false
  let hits = 0
  for (const line of sample) if (CODE_LINE_PATTERN.test(line) || /[;{}]\s*$/.test(line)) hits += 1
  return hits / sample.length >= 0.4
}

/** Deterministic format classification (order matters). */
export function classifyText(text) {
  const lines = text.split('\n')
  const trimmed = text.trim()
  if (trimmed.length > 1 && (trimmed.startsWith('{') || trimmed.startsWith('['))) {
    try {
      JSON.parse(trimmed)
      return 'json'
    } catch {
      // fall through to text formats
    }
  }
  if (looksLikeDiff(text, lines)) return 'diff'
  if (looksLikeLog(lines)) return 'log'
  if (looksLikeTable(lines)) return 'table'
  if (looksLikeCode(lines)) return 'code'
  return 'generic'
}

function restoreSingletonRuns(keep) {
  let index = 0
  while (index < keep.length) {
    if (keep[index]) { index += 1; continue }
    const start = index
    while (index < keep.length && !keep[index]) index += 1
    if (index - start === 1) keep[start] = true
  }
}

/** Join lines keeping the marked ones, replacing dropped runs with one pointer line. */
function joinWithOmissions(lines, keep, label) {
  const output = []
  let pointers = 0
  let run = 0
  for (let index = 0; index < lines.length; index += 1) {
    if (keep[index]) {
      if (run > 0) { output.push(label(run)); pointers += 1; run = 0 }
      output.push(truncateLongLine(lines[index]))
    } else {
      run += 1
    }
  }
  if (run > 0) { output.push(label(run)); pointers += 1 }
  return { lines: output, pointers }
}

function reduceJson(value, depth) {
  if (typeof value === 'string') {
    if (value.length > LIMITS.jsonStringChars) {
      const kept = value.slice(0, LIMITS.jsonStringChars)
      return { value: kept + `…[+${value.length - kept.length} chars]`, pointers: 1 }
    }
    return { value, pointers: 0 }
  }
  if (Array.isArray(value)) {
    const total = value.length
    if (depth >= LIMITS.jsonDepth) return { value: `…[${total} items, depth limit]`, pointers: 1 }
    const keepIndexes = new Set()
    const keepCount = Math.min(total, LIMITS.jsonArrayItems)
    for (let index = 0; index < keepCount; index += 1) keepIndexes.add(index)
    if (total > keepCount) {
      let extra = 0
      for (let index = keepCount; index < total && extra < LIMITS.jsonExtraErrorItems; index += 1) {
        const item = value[index]
        if (isObject(item) && (item.error || item.status === 'error' || item.status === 'failed' || item.level === 'error')) {
          keepIndexes.add(index)
          extra += 1
        }
      }
    }
    const output = []
    let pointers = 0
    let omitted = 0
    for (let index = 0; index < total; index += 1) {
      if (keepIndexes.has(index)) {
        const reduced = reduceJson(value[index], depth + 1)
        output.push(reduced.value)
        pointers += reduced.pointers
      } else {
        omitted += 1
      }
    }
    if (omitted > 0) {
      output.push(`… ${omitted} more items (total ${total})`)
      pointers += 1
    }
    return { value: output, pointers }
  }
  if (isObject(value)) {
    if (depth >= LIMITS.jsonDepth) return { value: '…', pointers: 1 }
    const output = {}
    let pointers = 0
    for (const key of Object.keys(value)) {
      const reduced = reduceJson(value[key], depth + 1)
      output[key] = reduced.value
      pointers += reduced.pointers
    }
    return { value: output, pointers }
  }
  return { value, pointers: 0 }
}

function compressJsonText(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  const reduced = reduceJson(parsed, 0)
  let candidate
  try {
    candidate = JSON.stringify(reduced.value)
  } catch {
    return null
  }
  if (typeof candidate !== 'string') return null
  return { text: candidate, pointers: reduced.pointers, format: 'json' }
}

function isChangedDiffLine(line) {
  if (line.startsWith('+++') || line.startsWith('---')) return false
  return line.startsWith('+') || line.startsWith('-')
}

function compressDiffText(text) {
  const lines = text.split('\n')
  const keep = new Array(lines.length).fill(false)
  const headerPattern = /^(?:diff --git |index [0-9a-f]{4,}|--- |\+\+\+ |@@ |Binary files |new file mode |deleted file mode |old mode |new mode |similarity index |rename from |rename to |\\ No newline)/
  let sawHeader = false
  for (let index = 0; index < lines.length; index += 1) {
    if (headerPattern.test(lines[index])) {
      keep[index] = true
      sawHeader = true
    }
  }
  let changed = 0
  for (let index = 0; index < lines.length; index += 1) {
    if (!isChangedDiffLine(lines[index])) continue
    changed += 1
    keep[index] = true
    for (let delta = 1; delta <= LIMITS.diffContext; delta += 1) {
      if (index - delta >= 0) keep[index - delta] = true
      if (index + delta < lines.length) keep[index + delta] = true
    }
  }
  if (!sawHeader && changed === 0) return { text, pointers: 0, format: 'diff' }
  restoreSingletonRuns(keep)
  const joined = joinWithOmissions(lines, keep, (count) => `… ${count} unchanged lines omitted …`)
  const candidate = joined.lines.join('\n')
  if (candidate === text) return { text, pointers: 0, format: 'diff' }
  return { text: candidate, pointers: joined.pointers, format: 'diff' }
}

function splitTableRow(line, delimiter) {
  if (delimiter === 'tab') return line.split('\t').map((cell) => cell.trim())
  if (delimiter === 'pipe') {
    let body = line.trim()
    if (body.startsWith('|')) body = body.slice(1)
    if (body.endsWith('|')) body = body.slice(0, -1)
    return body.split('|').map((cell) => cell.trim())
  }
  return line.trim().split(/\s{2,}/).map((cell) => cell.trim())
}

function formatTableRow(cells, delimiter) {
  if (delimiter === 'tab') return cells.join('\t').replace(/\t+$/, '')
  if (delimiter === 'pipe') return '| ' + cells.join(' | ') + ' |'
  return cells.join('\t').replace(/\t+$/, '')
}

function compressTableText(text) {
  const lines = text.split('\n')
  const nonEmpty = lines.filter((line) => line.trim().length > 0)
  const delimiter = detectTableDelimiter(nonEmpty)
  if (!delimiter) return null
  const rows = nonEmpty.map((line) => splitTableRow(line, delimiter))
  const columns = Math.max(...rows.map((row) => row.length))
  if (columns < 2) return null
  const normalizeRow = (cells) => {
    const output = cells.slice(0, columns)
    while (output.length < columns) output.push('')
    return output
  }
  const header = normalizeRow(rows[0])
  let index = 1
  let alignment = null
  if (rows[1] && rows[1].every((cell) => /^:?-{2,}:?$/.test(cell))) {
    alignment = normalizeRow(rows[1])
    index = 2
  }
  const body = rows.slice(index)
  if (body.length <= LIMITS.tableRows) return null
  const kept = body.slice(0, LIMITS.tableRows).map(normalizeRow)
  const output = [formatTableRow(header, delimiter)]
  if (alignment) output.push(formatTableRow(alignment.map((cell) => (cell.includes(':') ? cell : '---')), delimiter))
  for (const row of kept) output.push(formatTableRow(row, delimiter))
  output.push(`… ${body.length - LIMITS.tableRows} more rows (${body.length} data rows) …`)
  return { text: output.join('\n'), pointers: 1, format: 'table' }
}

function compressLogText(text) {
  const normalizedLines = text.split('\n').map(normalizeLogLine)
  const groups = []
  for (const line of normalizedLines) {
    const last = groups[groups.length - 1]
    if (last && last.line === line) last.count += 1
    else groups.push({ line, count: 1 })
  }
  let pointers = 0
  const lines = groups.map((group) => {
    if (group.count > 1) {
      pointers += 1
      return `${group.line}  [repeated x${group.count}]`
    }
    return group.line
  })
  const keep = new Array(lines.length).fill(false)
  const headEnd = Math.min(LIMITS.logHeadLines, lines.length)
  for (let index = 0; index < headEnd; index += 1) keep[index] = true
  const tailStart = Math.max(headEnd, lines.length - LIMITS.logTailLines)
  for (let index = tailStart; index < lines.length; index += 1) keep[index] = true
  let errorBudget = LIMITS.logMaxErrorLines
  for (let index = 0; index < lines.length; index += 1) {
    if (!keep[index] && errorBudget > 0 && LOG_ERROR_PATTERN.test(lines[index])) {
      keep[index] = true
      errorBudget -= 1
    }
  }
  const joined = joinWithOmissions(lines, keep, (count) => `… ${count} lines omitted …`)
  const candidate = joined.lines.join('\n')
  if (candidate === text) return { text, pointers: 0, format: 'log' }
  return { text: candidate, pointers: pointers + joined.pointers, format: 'log' }
}

function compressCodeText(text) {
  const lines = text.split('\n')
  let pointers = 0
  const truncated = lines.map((line) => {
    const next = truncateLongLine(line, LIMITS.codeLineChars)
    if (next !== line) pointers += 1
    return next
  })
  const keep = new Array(truncated.length).fill(true)
  const total = truncated.length
  if (total > LIMITS.codeHeadLines + LIMITS.codeTailLines + 1) {
    for (let index = LIMITS.codeHeadLines; index < total - LIMITS.codeTailLines; index += 1) keep[index] = false
  }
  const joined = joinWithOmissions(truncated, keep, (count) => `… ${count} lines omitted …`)
  const candidate = joined.lines.join('\n')
  if (candidate === text) return { text, pointers: 0, format: 'code' }
  return { text: candidate, pointers: pointers + joined.pointers, format: 'code' }
}

function compressGenericText(text) {
  const lines = text.split('\n')
  if (lines.length <= LIMITS.headLines + LIMITS.tailLines + 1) {
    let pointers = 0
    const candidate = lines.map((line) => {
      const next = truncateLongLine(line)
      if (next !== line) pointers += 1
      return next
    }).join('\n')
    return { text: candidate, pointers, format: 'generic' }
  }
  const keep = new Array(lines.length).fill(false)
  for (let index = 0; index < LIMITS.headLines; index += 1) keep[index] = true
  for (let index = lines.length - LIMITS.tailLines; index < lines.length; index += 1) keep[index] = true
  const joined = joinWithOmissions(lines, keep, (count) => `… ${count} lines omitted …`)
  return { text: joined.lines.join('\n'), pointers: joined.pointers, format: 'generic' }
}

/** Compact one text block. Returns the original text when the block is skipped. */
function compactBlock(text, m1) {
  if (typeof text !== 'string' || text.length === 0) return { text, pointers: 0, format: 'empty', skipped: 'empty' }
  if (SECRET_PATTERN.test(text)) return { text, pointers: 0, format: 'secret', skipped: 'secret' }
  const normalized = normalizeText(text)
  if (normalized.length === 0) return { text, pointers: 0, format: 'empty', skipped: 'empty' }
  if (SECRET_PATTERN.test(normalized)) return { text, pointers: 0, format: 'secret', skipped: 'secret' }
  const classified = classifyText(normalized)
  const enabled = m1.formats?.[classified] !== false
  let result = null
  if (enabled) {
    if (classified === 'json') result = compressJsonText(normalized)
    else if (classified === 'diff') result = compressDiffText(normalized)
    else if (classified === 'table') result = compressTableText(normalized)
    else if (classified === 'log') result = compressLogText(normalized)
    else if (classified === 'code') result = compressCodeText(normalized)
  }
  if (!result) result = compressGenericText(normalized)
  return { text: result.text, pointers: result.pointers, format: result.format, classified, normalized, skipped: null }
}

function unchanged(content, stats, reason) {
  return {
    changed: false,
    content,
    removedTokens: 0,
    addedTokens: 0,
    pointerCount: 0,
    stats: { ...stats, skipped: reason },
  }
}

/**
 * Compact one tool result deterministically.
 *
 * @param {object} input
 * @param {string} [input.toolName]
 * @param {{content: any[], isError?: boolean, meta?: object}} input.result
 * @param {object} [input.config] resolved CostPilot config (or a bare M1 slice)
 * @param {{pointerPath?: string, sessionId?: string, callId?: string, turn?: number, step?: number}} [input.context]
 * @returns {{changed: boolean, content: any[], removedTokens: number, addedTokens: number, pointerCount: number, stats: object}}
 */
export function compressToolResult({ toolName, result, config, context } = {}) {
  const m1 = pickM1(config)
  const stats = {
    tool: typeof toolName === 'string' ? toolName : null,
    format: 'text',
    formats: [],
    skipped: null,
    blocks: 0,
    textBlocks: 0,
    compressedBlocks: 0,
    skippedBlocks: [],
    originalChars: 0,
    normalizedChars: 0,
    compressedChars: 0,
    originalTokens: 0,
    compressedTokens: 0,
    removedTokens: 0,
    addedTokens: 0,
    netSavedTokens: 0,
    savingsRatio: 0,
    pointerCount: 0,
  }

  if (!isObject(result)) return unchanged([], stats, 'no-result')
  const originalContent = result.content
  if (!Array.isArray(originalContent)) return unchanged(originalContent ?? [], stats, 'no-content')
  stats.blocks = originalContent.length
  if (m1.enabled === false) return unchanged(originalContent, stats, 'disabled')
  if (result.isError === true && m1.compressErrors !== true) return unchanged(originalContent, stats, 'is-error')

  const pointerPath = typeof context?.pointerPath === 'string' && context.pointerPath.length > 0 && m1.sideStore !== false
    ? context.pointerPath
    : null
  const minDelta = Number.isFinite(m1.minDeltaTokens) ? Math.max(0, m1.minDeltaTokens) : DEFAULT_M1.minDeltaTokens

  const output = originalContent.slice()
  const formats = []
  const skippedBlocks = []
  let compressedBlocks = 0
  let removedTokens = 0
  let addedTokens = 0
  let pointerCount = 0

  for (let index = 0; index < originalContent.length; index += 1) {
    const block = originalContent[index]
    if (!isObject(block) || block.type !== 'text' || typeof block.text !== 'string') continue
    stats.textBlocks += 1
    const text = block.text
    stats.originalChars += text.length
    const originalTokens = estimateTokens(text)
    stats.originalTokens += originalTokens

    const compacted = compactBlock(text, m1)
    formats.push(compacted.format === 'secret' || compacted.format === 'empty' ? compacted.format : (compacted.classified ?? compacted.format))
    stats.normalizedChars += compacted.normalized ? compacted.normalized.length : text.length

    if (compacted.skipped) {
      skippedBlocks.push({ index, reason: compacted.skipped, format: compacted.format })
      stats.compressedChars += text.length
      stats.compressedTokens += originalTokens
      continue
    }

    let candidate = compacted.text
    let pointers = compacted.pointers
    if (pointerPath && candidate !== text) {
      candidate = `${candidate}\n… full output saved to ${pointerPath} (read it to recover) …`
      pointers += 1
    }

    if (candidate === text) {
      skippedBlocks.push({ index, reason: 'no-benefit', format: compacted.format })
      stats.compressedChars += text.length
      stats.compressedTokens += originalTokens
      continue
    }
    const compressedTokens = estimateTokens(candidate)
    if (originalTokens < minDelta) {
      skippedBlocks.push({ index, reason: 'below-min', format: compacted.format })
      stats.compressedChars += text.length
      stats.compressedTokens += originalTokens
      continue
    }
    if (originalTokens - compressedTokens < minDelta) {
      skippedBlocks.push({ index, reason: 'below-min-delta', format: compacted.format })
      stats.compressedChars += text.length
      stats.compressedTokens += originalTokens
      continue
    }

    output[index] = { ...block, text: candidate }
    compressedBlocks += 1
    pointerCount += pointers
    removedTokens += originalTokens
    addedTokens += compressedTokens
    stats.compressedChars += candidate.length
    stats.compressedTokens += compressedTokens
  }

  stats.formats = [...new Set(formats)]
  stats.compressedBlocks = compressedBlocks
  stats.skippedBlocks = skippedBlocks
  stats.removedTokens = removedTokens
  stats.addedTokens = addedTokens
  stats.pointerCount = pointerCount
  stats.netSavedTokens = stats.originalTokens - stats.compressedTokens
  stats.savingsRatio = removedTokens > 0 ? (removedTokens - addedTokens) / removedTokens : 0
  stats.format = stats.formats.length === 0
    ? 'text'
    : (stats.formats.length === 1 ? stats.formats[0] : 'mixed')

  if (compressedBlocks === 0) {
    const reasons = [...new Set(skippedBlocks.map((entry) => entry.reason).concat(stats.textBlocks === 0 ? ['no-text'] : []))]
    stats.skipped = reasons.length === 0 ? 'no-benefit' : (reasons.length === 1 ? reasons[0] : 'mixed')
    return { changed: false, content: originalContent, removedTokens: 0, addedTokens: 0, pointerCount: 0, stats }
  }

  return { changed: true, content: output, removedTokens, addedTokens, pointerCount, stats }
}

/** Sanitize a path segment; never yields '.', '..' or a separator. */
function safeSegment(value, fallback) {
  const raw = typeof value === 'string' ? value : ''
  let output = raw.replace(/[^A-Za-z0-9._-]+/g, '_')
  output = output.replace(/\.{2,}/g, '.')
  output = output.replace(/^\.+/, '').replace(/\.+$/, '')
  if (output.length > 120) output = output.slice(0, 120)
  if (output.length === 0) output = fallback
  return output
}

/**
 * Write the original (uncompacted) tool output into the side-store.
 *
 * Layout: `<originalsDir>/<sessionId>/<callId>.txt`. `dir` may be either the
 * CostPilot data directory (`$DSH_HOME/costpilot`, then `originals/` is
 * appended) or the originals directory itself (its basename is `originals`).
 * Synchronous on purpose: the tools/post-execute replacement must know the
 * pointer path before it returns the compacted content. Callers only invoke
 * this after a successful compaction (result.changed === true), so large
 * originals are persisted while small outputs never reach the disk.
 *
 * @param {{dir: string, sessionId: string, callId: string, text: string}} input
 * @returns {{path: string, bytes: number, sha256: string}}
 */
export function writeSideStore({ dir, sessionId, callId, text } = {}) {
  if (typeof dir !== 'string' || dir.length === 0) throw new TypeError('writeSideStore: dir is required')
  if (typeof text !== 'string') throw new TypeError('writeSideStore: text must be a string')
  const originalsDir = path.basename(path.resolve(dir)) === 'originals' ? dir : path.join(dir, 'originals')
  const sessionName = safeSegment(sessionId, 'session')
  const callName = safeSegment(callId, 'call')
  const targetDir = path.join(originalsDir, sessionName)
  const targetPath = path.join(targetDir, callName + '.txt')
  mkdirSync(targetDir, { recursive: true })
  const bytes = Buffer.byteLength(text, 'utf8')
  const sha256 = createHash('sha256').update(text, 'utf8').digest('hex')
  writeFileSync(targetPath, text, 'utf8')
  return { path: targetPath, bytes, sha256 }
}
