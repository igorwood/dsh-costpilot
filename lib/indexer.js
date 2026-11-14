/**
 * M4: cross-session workspace index backed by node:sqlite.
 *
 * The index is a local SQLite file (default <workspace>/.dsh-costpilot/index.db)
 * with three tables:
 *
 *   files(path PRIMARY KEY, name, language, lines, mtime, size)
 *   entries(path, name, kind, parent, line_start, line_end, meta)
 *   meta(key, value)                       -- schema_version, root, built_at
 *
 * Design constraints (IMPLEMENTATION-v1.md, section A):
 *  - pure node:fs traversal, no DSH services required
 *  - ignore config.ignoreDirs / config.exclude / >maxFileBytes / binary files
 *  - at most config.maxFiles files
 *  - incremental refresh via markDirty() and mtime/size comparison
 *  - full rebuild when schema_version or the workspace root does not match
 *  - read-only SQL only; a single SELECT wrapped as
 *      SELECT * FROM (<sql>) LIMIT maxRows
 *  - every failure surfaces as an Error whose message locates the query
 *
 * @module dsh-costpilot/lib/indexer
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DEFAULTS } from './config.js'

/** On-disk schema version. Bump to force a full rebuild. */
export const SCHEMA_VERSION = 1

/** Default index location relative to the workspace root. */
export const DEFAULT_INDEX_PATH = '.dsh-costpilot/index.db'

const M4_DEFAULTS = DEFAULTS.modules.M4
const BINARY_PROBE_BYTES = 8000
const MAX_ENTRIES_PER_FILE = 5000
const MAX_NAME_CHARS = 300

const LANGUAGE_BY_EXT = new Map([
  ['ts', 'typescript'], ['tsx', 'typescript'], ['mts', 'typescript'], ['cts', 'typescript'],
  ['js', 'javascript'], ['jsx', 'javascript'], ['mjs', 'javascript'], ['cjs', 'javascript'],
  ['py', 'python'],
  ['go', 'go'],
  ['md', 'markdown'], ['markdown', 'markdown'],
])

const SQL_FORBIDDEN = /\b(?:pragma|attach|detach|insert|update|delete|drop|alter|create|replace|vacuum|reindex|load_extension)\b/i

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toPosix(filePath) {
  return filePath.split(path.sep).join('/')
}

function positiveNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function positiveInteger(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 1 ? Math.floor(number) : fallback
}

/** Merge a resolved plugin config (or a bare M4 config) with M4 defaults. */
function resolveM4Config(config) {
  const explicit = isPlainObject(config)
    ? (isPlainObject(config.modules) ? config.modules.M4 : config)
    : undefined
  return { ...M4_DEFAULTS, ...(isPlainObject(explicit) ? explicit : {}) }
}

/** Detect the language bucket used by the extractor. */
export function detectLanguage(filePath) {
  const ext = path.extname(String(filePath ?? '')).slice(1).toLowerCase()
  return LANGUAGE_BY_EXT.get(ext) ?? 'text'
}

/** True when the byte prefix contains a NUL byte (binary heuristic). */
function looksBinary(buffer) {
  const limit = Math.min(buffer.length, BINARY_PROBE_BYTES)
  for (let i = 0; i < limit; i += 1) {
    if (buffer[i] === 0) return true
  }
  return false
}

function countLines(text) {
  if (text.length === 0) return 0
  const newlines = (text.match(/\n/g) ?? []).length
  return text.endsWith('\n') ? newlines : newlines + 1
}

function compileGlob(pattern) {
  let source = '^'
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]
    if (char === '*') {
      if (pattern[i + 1] === '*') { source += '.*'; i += 1 }
      else source += '[^/]*'
    } else if (char === '?') {
      source += '[^/]'
    } else if ('.+^$(){}[]=!<>|\\'.includes(char)) {
      source += '\\' + char
    } else {
      source += char
    }
  }
  return new RegExp(source + '$')
}

/** Matcher for config.exclude globs ('*.pem' style, against basename or relative path). */
function createExcludeMatcher(patterns) {
  const rules = []
  for (const raw of Array.isArray(patterns) ? patterns : []) {
    if (typeof raw !== 'string' || raw.trim().length === 0) continue
    const pattern = raw.trim().replace(/^\.\//, '').replace(/^\//, '')
    rules.push({ hasSlash: pattern.includes('/'), regex: compileGlob(pattern) })
  }
  return (relPath, name) => {
    for (const rule of rules) {
      if (rule.regex.test(rule.hasSlash ? relPath : name)) return true
    }
    return false
  }
}

function capName(name) {
  const text = String(name ?? '').trim()
  return text.length > MAX_NAME_CHARS ? text.slice(0, MAX_NAME_CHARS) : text
}

/**
 * Extract structural entries from one file. Pure function; line numbers are
 * 1-based. Kinds: import/export/class/function/interface/type/method/heading/todo.
 *
 * @param {{ path: string, content: string, language?: string }} input
 * @returns {Array<{name: string, kind: string, parent: string|null, line_start: number, line_end: number, meta: object|null}>}
 */
export function extractEntries({ path: relPath, content, language } = {}) {
  const source = typeof content === 'string' ? content : ''
  const lines = source.split(/\r\n|\r|\n/)
  const entries = []
  const namedLines = new Set()
  const lang = language ?? detectLanguage(relPath)

  const push = (lineNumber, kind, name, parent = null, meta = null, lineEnd = lineNumber) => {
    if (entries.length >= MAX_ENTRIES_PER_FILE) return
    const value = capName(name)
    if (value.length === 0) return
    entries.push({
      name: value,
      kind,
      parent: parent ? capName(parent) : null,
      line_start: lineNumber,
      line_end: Math.max(lineNumber, lineEnd),
      meta: isPlainObject(meta) ? meta : null,
    })
    namedLines.add(lineNumber)
  }

  if (lang === 'typescript' || lang === 'javascript') {
    extractJs(lines, push)
  } else if (lang === 'python') {
    extractPython(lines, push)
  } else if (lang === 'go') {
    extractGo(lines, push)
  } else if (lang === 'markdown') {
    extractMarkdown(lines, push)
  }

  // Fallback: TODO/FIXME markers are searchable in every language.
  for (let i = 0; i < lines.length; i += 1) {
    const lineNumber = i + 1
    if (namedLines.has(lineNumber)) continue
    const match = /\b(TODO|FIXME|XXX|HACK)\b/.exec(lines[i])
    if (!match) continue
    const text = lines[i].trim()
    push(lineNumber, 'todo', match[1], null, { text: text.length > 200 ? text.slice(0, 200) : text })
  }

  return entries
}

function extractJs(lines, push) {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const lineNumber = i + 1
    let match

    // import x from 'm' / import {a} from 'm' / import * as ns from 'm'
    if ((match = /^\s*import\s+(?:type\s+)?(.+?)\s+from\s+['"]([^'"]+)['"]/.exec(line))) {
      push(lineNumber, 'import', match[2], null, { bindings: match[1].trim() })
    } else if ((match = /^\s*import\s+['"]([^'"]+)['"]/.exec(line))) {
      push(lineNumber, 'import', match[1], null, { sideEffect: true })
    } else if (/^\s*import\b/.test(line)) {
      // Multi-line import: the module specifier is on a later line.
      for (let j = i + 1; j < Math.min(lines.length, i + 12); j += 1) {
        const continued = /from\s+['"]([^'"]+)['"]/.exec(lines[j])
        if (continued) { push(lineNumber, 'import', continued[1], null, { multiline: true }); break }
        if (/^\s*import\b/.test(lines[j])) break
      }
    }

    // export ... from 'm' / export const NAME
    if ((match = /^\s*export\s+.*?from\s+['"]([^'"]+)['"]/.exec(line))) {
      push(lineNumber, 'export', match[1], null, { reexport: true })
    } else if ((match = /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(line))) {
      push(lineNumber, 'export', match[1], null, { declaration: 'variable' })
    }

    // class
    if ((match = /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(line))) {
      push(lineNumber, 'class', match[1])
    }

    // function
    if ((match = /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(line))) {
      push(lineNumber, 'function', match[1])
    }

    // interface
    if ((match = /^\s*(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/.exec(line))) {
      push(lineNumber, 'interface', match[1])
    }

    // type alias
    if ((match = /^\s*(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/.exec(line))) {
      push(lineNumber, 'type', match[1])
    }

    // CommonJS require
    if ((match = /require\(\s*['"]([^'"]+)['"]\s*\)/.exec(line))) {
      push(lineNumber, 'import', match[1], null, { require: true })
    }
  }
}

function extractPython(lines, push) {
  /** @type {Array<{indent: number, name: string}>} */
  const classes = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim().length === 0) continue
    const indent = (line.match(/^\s*/) ?? [''])[0].length
    const classMatch = /^\s*class\s+([A-Za-z_]\w*)/.exec(line)

    if (classMatch) {
      while (classes.length > 0 && indent <= classes[classes.length - 1].indent) classes.pop()
      const parent = classes.length > 0 ? classes[classes.length - 1].name : null
      push(i + 1, 'class', classMatch[1], parent)
      classes.push({ indent, name: classMatch[1] })
      continue
    }

    const defMatch = /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(line)
    if (defMatch) {
      while (classes.length > 0 && indent <= classes[classes.length - 1].indent) classes.pop()
      const parent = classes.length > 0 ? classes[classes.length - 1].name : null
      push(i + 1, parent ? 'method' : 'function', defMatch[1], parent)
      continue
    }

    while (classes.length > 0 && indent <= classes[classes.length - 1].indent) classes.pop()
  }
}

function extractGo(lines, push) {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    let match
    // Method: func (r *Receiver) Name(...)
    if ((match = /^\s*func\s+\(\s*(?:[A-Za-z_]\w*\s+)?\*?([A-Za-z_]\w*)\s*\)\s*([A-Za-z_]\w*)\s*\(/.exec(line))) {
      push(i + 1, 'method', match[2], match[1])
      continue
    }
    if ((match = /^\s*func\s+([A-Za-z_]\w*)\s*\(/.exec(line))) {
      push(i + 1, 'function', match[1])
      continue
    }
    if ((match = /^\s*type\s+([A-Za-z_]\w*)\s+(struct|interface|map|func|chan|\[\]|[A-Za-z_]\w*)/.exec(line))) {
      push(i + 1, 'type', match[1], null, { underlying: match[2] })
    }
  }
}

function extractMarkdown(lines, push) {
  const headings = []
  let inFence = false
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^\s*(?:\x60{3,}|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (!match) continue
    headings.push({ index: i, level: match[1].length, text: match[2] })
  }
  for (let h = 0; h < headings.length; h += 1) {
    const heading = headings[h]
    const next = headings[h + 1]
    const lineEnd = next ? next.index : lines.length
    push(heading.index + 1, 'heading', heading.text, null, { level: heading.level }, lineEnd)
  }
}

/** Validate that a query is a single, read-only SELECT statement. */
export function validateReadOnlySql(sql) {
  if (typeof sql !== 'string') return { ok: false, reason: 'sql must be a string' }
  let text = sql.trim()
  if (text.length === 0) return { ok: false, reason: 'sql is empty' }
  if (text.endsWith(';')) text = text.slice(0, -1).trim()
  if (text.length === 0) return { ok: false, reason: 'sql is empty' }
  if (text.includes(';')) return { ok: false, reason: 'multiple statements are not allowed' }
  if (text.includes('--') || text.includes('/*') || text.includes('*/')) {
    return { ok: false, reason: 'SQL comments are not allowed' }
  }
  if (!/^select\b/i.test(text)) return { ok: false, reason: 'only a single SELECT statement is allowed' }
  const forbidden = SQL_FORBIDDEN.exec(text)
  if (forbidden) return { ok: false, reason: 'forbidden keyword: ' + forbidden[0].toUpperCase() }
  return { ok: true, sql: text }
}

function previewSql(sql) {
  const text = typeof sql === 'string' ? sql.replace(/\s+/g, ' ').trim() : String(sql)
  return text.length > 160 ? text.slice(0, 160) + '...' : text
}

/**
 * Create the M4 workspace index.
 *
 * @param {{ root: string, dbPath?: string, config?: object, logger?: object|Function }} options
 * @returns {{
 *   ensureFresh: () => {built: boolean, files: number, entries: number, builtAt: string|null, stale: boolean},
 *   query: (sql: string) => {columns: string[], rows: unknown[][], ms: number, truncated: boolean},
 *   markDirty: (paths?: string|string[]) => number,
 *   stats: () => {files: number, entries: number, builtAt: string|null, root: string, dbPath: string, dirty: number},
 *   close: () => void,
 * }}
 */
export function createIndex({ root, dbPath, config, logger } = {}) {
  if (typeof root !== 'string' || root.trim().length === 0) {
    throw new TypeError('createIndex requires { root }')
  }
  const rootPath = path.resolve(root)
  let rootStat
  try {
    rootStat = fs.statSync(rootPath)
  } catch {
    throw new Error('createIndex: workspace root does not exist: ' + rootPath)
  }
  if (!rootStat.isDirectory()) {
    throw new Error('createIndex: workspace root is not a directory: ' + rootPath)
  }

  const m4 = resolveM4Config(config)
  const relativeIndexPath = typeof m4.indexPath === 'string' && m4.indexPath.length > 0
    ? m4.indexPath
    : DEFAULT_INDEX_PATH
  const dbFile = typeof dbPath === 'string' && dbPath.length > 0
    ? path.resolve(rootPath, dbPath)
    : path.join(rootPath, relativeIndexPath)

  const maxFiles = Number.isFinite(Number(m4.maxFiles)) && Number(m4.maxFiles) >= 1
    ? Math.floor(Number(m4.maxFiles))
    : Infinity
  const maxFileBytes = positiveNumber(m4.maxFileBytes, 2_000_000)
  const maxRows = positiveInteger(m4.maxRows, 200)
  const ignoreDirs = new Set(['.dsh-costpilot', ...(Array.isArray(m4.ignoreDirs) ? m4.ignoreDirs : [])])
  const isExcluded = createExcludeMatcher(m4.exclude)
  const dbRelative = (() => {
    const rel = toPosix(path.relative(rootPath, dbFile))
    return rel.startsWith('..') ? null : rel
  })()

  /** @type {DatabaseSync|null} */
  let writeConn = null
  /** @type {DatabaseSync|null} */
  let readConn = null
  /** @type {ReturnType<typeof prepareStatements>|null} */
  let statements = null
  let needsRebuild = false
  let builtAt = null
  let closed = false
  let dirtyAll = false
  const dirtyPaths = new Set()

  function log(...args) {
    const sink = typeof logger === 'function' ? logger : logger?.debug
    if (typeof sink !== 'function') return
    try { sink.call(logger, '[m4]', ...args) } catch {}
  }

  function assertOpen() {
    if (closed) throw new Error('index is closed')
  }

  function metaValue(key) {
    const row = writeConn.prepare('SELECT value FROM meta WHERE key = ?').get(key)
    return row ? row.value : null
  }

  function setMetaValue(key, value) {
    writeConn.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value === null || value === undefined ? null : String(value))
  }

  function createTables() {
    writeConn.exec([
      'CREATE TABLE IF NOT EXISTS files (',
      '  path TEXT PRIMARY KEY,',
      '  name TEXT NOT NULL,',
      '  language TEXT,',
      '  lines INTEGER,',
      '  mtime REAL,',
      '  size INTEGER',
      ')',
    ].join('\n'))
    writeConn.exec([
      'CREATE TABLE IF NOT EXISTS entries (',
      '  path TEXT NOT NULL,',
      '  name TEXT,',
      '  kind TEXT NOT NULL,',
      '  parent TEXT,',
      '  line_start INTEGER NOT NULL,',
      '  line_end INTEGER NOT NULL,',
      '  meta TEXT',
      ')',
    ].join('\n'))
    writeConn.exec('CREATE INDEX IF NOT EXISTS entries_path_idx ON entries(path)')
    writeConn.exec('CREATE INDEX IF NOT EXISTS entries_kind_idx ON entries(kind)')
  }

  function initSchema() {
    writeConn.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)')
    createTables()
    const version = metaValue('schema_version')
    const storedRoot = metaValue('root')
    if (version !== String(SCHEMA_VERSION)) {
      writeConn.exec('DROP TABLE IF EXISTS entries')
      writeConn.exec('DROP TABLE IF EXISTS files')
      createTables()
      setMetaValue('schema_version', String(SCHEMA_VERSION))
      setMetaValue('root', rootPath)
      writeConn.prepare("DELETE FROM meta WHERE key = 'built_at'").run()
      builtAt = null
      needsRebuild = true
      log('schema rebuild (version', version, '->', SCHEMA_VERSION + ')')
    } else if (storedRoot !== rootPath) {
      writeConn.exec('DELETE FROM entries')
      writeConn.exec('DELETE FROM files')
      setMetaValue('root', rootPath)
      writeConn.prepare("DELETE FROM meta WHERE key = 'built_at'").run()
      builtAt = null
      needsRebuild = true
      log('workspace root changed; rebuilding index for', rootPath)
    } else {
      needsRebuild = false
      builtAt = metaValue('built_at')
    }
  }

  function openWrite() {
    // Never recreate a vanished workspace just to hold the index file.
    if (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) {
      throw new Error('workspace root is not accessible: ' + rootPath)
    }
    if (writeConn) return writeConn
    fs.mkdirSync(path.dirname(dbFile), { recursive: true })
    writeConn = new DatabaseSync(dbFile)
    try { writeConn.exec('PRAGMA busy_timeout = 2000') } catch {}
    initSchema()
    statements = prepareStatements(writeConn)
    return writeConn
  }

  function openRead() {
    if (readConn) return readConn
    if (!fs.existsSync(dbFile)) return null
    try {
      readConn = new DatabaseSync(dbFile, { readOnly: true })
    } catch (error) {
      if (!/readOnly|read-only|unknown option/i.test(String(error?.message ?? error))) throw error
      // Older node:sqlite builds may not accept readOnly; validation above still
      // guarantees only a single SELECT can reach the connection.
      readConn = new DatabaseSync(dbFile)
    }
    return readConn
  }

  function prepareStatements(conn) {
    return {
      deleteEntries: conn.prepare('DELETE FROM entries WHERE path = ?'),
      deleteFile: conn.prepare('DELETE FROM files WHERE path = ?'),
      insertFile: conn.prepare('INSERT OR REPLACE INTO files(path, name, language, lines, mtime, size) VALUES(?, ?, ?, ?, ?, ?)'),
      insertEntry: conn.prepare('INSERT INTO entries(path, name, kind, parent, line_start, line_end, meta) VALUES(?, ?, ?, ?, ?, ?, ?)'),
      countFiles: conn.prepare('SELECT COUNT(*) AS n FROM files'),
      countEntries: conn.prepare('SELECT COUNT(*) AS n FROM entries'),
    }
  }

  function isDbArtifact(relPath) {
    if (!dbRelative) return false
    if (relPath === dbRelative) return true
    return relPath === dbRelative + '-wal' || relPath === dbRelative + '-shm'
      || relPath === dbRelative + '-journal'
  }

  function isInsideDbDir(relDir) {
    if (!dbRelative) return false
    const dbDir = toPosix(path.dirname(dbRelative))
    if (dbDir === '.' || dbDir === '') return false
    return relDir === dbDir || relDir.startsWith(dbDir + '/')
  }

  function scanTree() {
    if (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) {
      throw new Error('ensureFresh: workspace root is not accessible: ' + rootPath)
    }
    const found = []
    const stack = ['']
    while (stack.length > 0) {
      const relDir = stack.pop()
      const absDir = relDir.length === 0 ? rootPath : path.join(rootPath, ...relDir.split('/'))
      let dirents
      try {
        dirents = fs.readdirSync(absDir, { withFileTypes: true })
      } catch {
        continue
      }
      dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      for (const dirent of dirents) {
        const relPath = relDir.length === 0 ? dirent.name : relDir + '/' + dirent.name
        if (dirent.isDirectory()) {
          if (ignoreDirs.has(dirent.name)) continue
          if (isInsideDbDir(relPath)) continue
          stack.push(relPath)
        } else if (dirent.isFile()) {
          if (isDbArtifact(relPath)) continue
          if (isExcluded(relPath, dirent.name)) continue
          found.push(relPath)
        }
      }
    }
    found.sort()
    return found
  }

  function indexFile(relPath, stat, text) {
    const stmts = statements ?? prepareStatements(writeConn)
    statements = stmts
    const language = detectLanguage(relPath)
    const entries = extractEntries({ path: relPath, content: text, language })
    stmts.deleteEntries.run(relPath)
    stmts.insertFile.run(relPath, path.posix.basename(relPath), language, countLines(text), stat.mtimeMs, stat.size)
    for (const entry of entries) {
      stmts.insertEntry.run(
        relPath,
        entry.name,
        entry.kind,
        entry.parent,
        entry.line_start,
        entry.line_end,
        entry.meta ? JSON.stringify(entry.meta) : null,
      )
    }
    return entries.length
  }

  function deleteFileRows(relPath) {
    const stmts = statements ?? prepareStatements(writeConn)
    statements = stmts
    stmts.deleteEntries.run(relPath)
    stmts.deleteFile.run(relPath)
  }

  function resetConnections() {
    for (const conn of [readConn, writeConn]) {
      if (conn) { try { conn.close() } catch {} }
    }
    readConn = null
    writeConn = null
    statements = null
    builtAt = null
  }

  function ensureFresh() {
    assertOpen()
    // The db file can disappear (manual cleanup); reopen and rebuild rather
    // than writing to a deleted inode.
    if (!fs.existsSync(dbFile)) resetConnections()
    openWrite()
    // Access the workspace before touching rows: a missing workspace must be an
    // error, not a silent index wipe.
    if (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) {
      throw new Error('ensureFresh: workspace root is not accessible: ' + rootPath)
    }
    const candidates = scanTree()
    const existing = new Map()
    for (const row of writeConn.prepare('SELECT path, mtime, size FROM files').all()) {
      existing.set(row.path, row)
    }

    let changes = needsRebuild
    let indexed = 0
    let removed = 0
    let truncated = false
    const seen = new Set()

    writeConn.exec('BEGIN IMMEDIATE')
    try {
      if (needsRebuild) {
        writeConn.exec('DELETE FROM entries')
        writeConn.exec('DELETE FROM files')
        existing.clear()
      }

      for (let i = 0; i < candidates.length; i += 1) {
        if (seen.size >= maxFiles) { truncated = true; break }
        const relPath = candidates[i]
        const absPath = path.join(rootPath, ...relPath.split('/'))
        let stat
        try { stat = fs.statSync(absPath) } catch { continue }
        if (stat.size > maxFileBytes) continue

        const row = existing.get(relPath)
        const isDirty = dirtyAll || dirtyPaths.has(relPath)
        const unchanged = !needsRebuild && !isDirty && row !== undefined
          && Number(row.mtime) === stat.mtimeMs && Number(row.size) === stat.size
        if (unchanged) { seen.add(relPath); continue }

        let buffer
        try { buffer = fs.readFileSync(absPath) } catch { continue }
        if (looksBinary(buffer)) {
          if (row) { deleteFileRows(relPath); changes = true; removed += 1 }
          continue
        }
        try {
          indexFile(relPath, stat, buffer.toString('utf8'))
        } catch (error) {
          // One unreadable/unparseable file must not abort the whole build.
          log('indexing failed for', relPath, error?.message ?? error)
          continue
        }
        seen.add(relPath)
        indexed += 1
        changes = true
      }

      if (!truncated) {
        for (const relPath of existing.keys()) {
          if (seen.has(relPath)) continue
          deleteFileRows(relPath)
          changes = true
          removed += 1
        }
        dirtyPaths.clear()
        dirtyAll = false
      } else {
        // Keep dirty markers that were not reached because of maxFiles.
        for (const relPath of [...dirtyPaths]) {
          if (seen.has(relPath)) dirtyPaths.delete(relPath)
        }
      }

      if (changes) {
        builtAt = new Date().toISOString()
        setMetaValue('built_at', builtAt)
      }
      writeConn.exec('COMMIT')
    } catch (error) {
      try { writeConn.exec('ROLLBACK') } catch {}
      throw error
    }

    if (needsRebuild) needsRebuild = false
    const fileCount = statements.countFiles.get().n
    const entryCount = statements.countEntries.get().n
    if (indexed > 0 || removed > 0 || candidates.length === 0) {
      log('ensureFresh: indexed', indexed, 'removed', removed, 'files', fileCount, 'entries', entryCount)
    }
    return {
      built: changes,
      files: fileCount,
      entries: entryCount,
      builtAt,
      stale: truncated,
      indexed,
      removed,
    }
  }

  function query(sql) {
    assertOpen()
    const checked = validateReadOnlySql(sql)
    if (!checked.ok) {
      throw new Error('index_query: rejected SQL (' + checked.reason + '): ' + previewSql(sql))
    }
    if (!fs.existsSync(dbFile)) resetConnections()
    openWrite()
    if (builtAt === null) ensureFresh()
    const conn = openRead()
    if (!conn) throw new Error('index_query: index database is not available: ' + dbFile)

    const wrapped = 'SELECT * FROM (' + checked.sql + ') LIMIT ' + (maxRows + 1)
    const started = Date.now()
    let raw
    let columns
    try {
      const stmt = conn.prepare(wrapped)
      columns = stmt.columns().map((column) => column.name)
      if (typeof stmt.setReturnArrays === 'function') {
        stmt.setReturnArrays(true)
        raw = stmt.all()
      } else {
        raw = stmt.all().map((row) => Object.values(row))
      }
    } catch (error) {
      throw new Error('index_query: SQL error: ' + (error?.message ?? String(error)) + ' | sql: ' + previewSql(checked.sql), { cause: error })
    }
    const ms = Date.now() - started
    const truncated = raw.length > maxRows
    return {
      columns,
      rows: truncated ? raw.slice(0, maxRows) : raw,
      ms,
      truncated,
    }
  }

  function markDirty(paths) {
    assertOpen()
    if (paths === undefined || paths === null) {
      dirtyAll = true
      return 1
    }
    const list = Array.isArray(paths) ? paths : [paths]
    let added = 0
    for (const item of list) {
      if (typeof item !== 'string' || item.trim().length === 0) continue
      const relPath = normalizeRelative(item.trim())
      if (!relPath) continue
      const absPath = path.join(rootPath, ...relPath.split('/'))
      let stat = null
      try { stat = fs.statSync(absPath) } catch {}
      if (stat?.isDirectory()) {
        for (const inner of listFilesRecursive(absPath)) {
          const innerRel = toPosix(path.relative(rootPath, inner))
          if (innerRel.length === 0 || innerRel.startsWith('..')) continue
          dirtyPaths.add(innerRel)
          added += 1
        }
      } else {
        dirtyPaths.add(relPath)
        added += 1
      }
    }
    return added
  }

  function normalizeRelative(input) {
    const absPath = path.isAbsolute(input) ? path.resolve(input) : path.resolve(rootPath, input)
    const relPath = toPosix(path.relative(rootPath, absPath))
    if (relPath.length === 0 || relPath === '.' || relPath === '..' || relPath.startsWith('../')) return null
    return relPath
  }

  function stats() {
    assertOpen()
    if (!fs.existsSync(dbFile)) resetConnections()
    openWrite()
    const fileCount = statements.countFiles.get().n
    const entryCount = statements.countEntries.get().n
    const dirty = dirtyAll ? fileCount : dirtyPaths.size
    return {
      files: fileCount,
      entries: entryCount,
      builtAt,
      root: rootPath,
      dbPath: dbFile,
      dirty,
    }
  }

  function close() {
    if (closed) return
    closed = true
    resetConnections()
  }

  return { ensureFresh, query, markDirty, stats, close }
}

/** Recursively list regular files under a directory (used for markDirty(dir)). */
function listFilesRecursive(dir) {
  const out = []
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    let dirents
    try { dirents = fs.readdirSync(current, { withFileTypes: true }) } catch { continue }
    for (const dirent of dirents) {
      const absPath = path.join(current, dirent.name)
      if (dirent.isDirectory()) stack.push(absPath)
      else if (dirent.isFile()) out.push(absPath)
    }
  }
  return out
}
