/**
 * M4 tests: cross-session SQLite index + index_query ToolDefinition.
 *
 * Run: node --test test/m4.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  SCHEMA_VERSION,
  createIndex,
  detectLanguage,
  extractEntries,
  validateReadOnlySql,
} from '../lib/indexer.js'
import { INDEX_TOOL_NAME, createIndexTool, formatIndexResult } from '../lib/index-tool.js'

// ---------------------------------------------------------------- helpers

const APP_TS = [
  "import { helper } from './helper'",
  '',
  'export class Widget {',
  '  run(): void {}',
  '}',
  '',
  'export function makeWidget(): Widget {',
  '  return new Widget()',
  '}',
  '',
  'export interface WidgetOptions {',
  '  size: number',
  '}',
  '',
  "export type WidgetKind = 'small' | 'large'",
  '',
  '// TODO: memoize makeWidget',
  '',
].join('\n')

const HELPER_JS = [
  'export function helper(value) {',
  '  return value',
  '}',
  '',
  'export const HELPER_VERSION = 1',
  '',
].join('\n')

const PARSER_PY = [
  'class Parser:',
  '    def parse(self, text):',
  '        return text.split()',
  '',
  'def load(path):',
  '    with open(path) as handle:',
  '        return handle.read()',
  '',
].join('\n')

const MAIN_GO = [
  'package main',
  '',
  'type Server struct {',
  '  addr string',
  '}',
  '',
  'func NewServer() *Server {',
  '  return &Server{}',
  '}',
  '',
  'func (s *Server) Start() error {',
  '  return nil',
  '}',
  '',
].join('\n')

const README_MD = [
  '# CostPilot Index',
  '',
  'Intro line.',
  '',
  '## Usage',
  '',
  'Run the index.',
  '',
  '### Example',
  '',
  'SELECT path FROM files',
  '',
].join('\n')

/** Files that must be indexed: 6 text files. */
const FIXTURE = {
  'src/app.ts': APP_TS,
  'src/helper.js': HELPER_JS,
  'lib/parser.py': PARSER_PY,
  'go/main.go': MAIN_GO,
  'README.md': README_MD,
  'notes/todo.txt': 'FIXME: rotate the index keys\n',
  'node_modules/pkg/index.js': 'export const hidden = 1\n',
  '.git/config': '[core]\n\trepositoryformatversion = 0\n',
  'build/out.js': 'export const bundled = true\n',
  'secret.pem': '-----BEGIN PRIVATE KEY-----\n',
  '.env': 'TOKEN=do-not-index\n',
  'assets/blob.bin': Buffer.from([0, 1, 2, 3, 0, 255]),
}

const FIXTURE_FILES = Object.keys(FIXTURE)
  .filter((rel) => !rel.startsWith('node_modules/') && !rel.startsWith('.git/') && !rel.startsWith('build/'))
  .filter((rel) => !rel.endsWith('.pem') && !rel.endsWith('/.env') && rel !== '.env' && !rel.endsWith('.bin'))
  .sort()

function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'))
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
  }
}

function makeWorkspace(t, files = FIXTURE) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'costpilot-m4-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  writeTree(root, files)
  return root
}

function makeIndex(t, root, options = {}) {
  const index = createIndex({ root, ...options })
  t.after(() => { try { index.close() } catch {} })
  return index
}

function configWith(m4) {
  return { modules: { M4: m4 } }
}

function toObjects(result) {
  const columns = result.columns
  return result.rows.map((row) => {
    const out = {}
    for (let i = 0; i < columns.length; i += 1) out[columns[i]] = row[i]
    return out
  })
}

// ---------------------------------------------------------------- build

test('m4: builds a fresh index with stats and the default db path', (t) => {
  const root = makeWorkspace(t)
  const index = makeIndex(t, root)

  assert.equal(index.stats().builtAt, null)
  const result = index.ensureFresh()
  assert.equal(result.built, true)
  assert.equal(result.files, FIXTURE_FILES.length)
  assert.ok(result.entries >= 18, 'expected structural entries, got ' + result.entries)
  assert.equal(result.stale, false)
  assert.equal(result.indexed, FIXTURE_FILES.length)
  assert.match(result.builtAt, /^\d{4}-\d{2}-\d{2}T/)

  const stats = index.stats()
  assert.equal(stats.files, FIXTURE_FILES.length)
  assert.equal(stats.entries, result.entries)
  assert.equal(stats.builtAt, result.builtAt)
  assert.equal(stats.root, path.resolve(root))
  assert.equal(stats.dbPath, path.join(path.resolve(root), '.dsh-costpilot', 'index.db'))
  assert.ok(fs.existsSync(stats.dbPath), 'index db should exist on disk')
  assert.equal(stats.dirty, 0)

  const files = index.query('SELECT path FROM files ORDER BY path')
  assert.deepEqual(files.rows.map((row) => row[0]), FIXTURE_FILES)
  assert.equal(files.truncated, false)
  assert.ok(files.ms >= 0)
})

test('m4: extracts 1-based symbols from ts/js/py/go/markdown and TODOs', (t) => {
  const root = makeWorkspace(t)
  const index = makeIndex(t, root)
  index.ensureFresh()

  const appEntries = toObjects(index.query(
    "SELECT name, kind, line_start FROM entries WHERE path = 'src/app.ts' ORDER BY line_start",
  ))
  const byName = new Map(appEntries.map((entry) => [entry.name, entry]))
  assert.deepEqual(byName.get('./helper'), { name: './helper', kind: 'import', line_start: 1 })
  assert.deepEqual(byName.get('Widget'), { name: 'Widget', kind: 'class', line_start: 3 })
  assert.deepEqual(byName.get('makeWidget'), { name: 'makeWidget', kind: 'function', line_start: 7 })
  assert.deepEqual(byName.get('WidgetOptions'), { name: 'WidgetOptions', kind: 'interface', line_start: 11 })
  assert.deepEqual(byName.get('WidgetKind'), { name: 'WidgetKind', kind: 'type', line_start: 15 })
  assert.equal(byName.get('TODO').kind, 'todo')
  assert.equal(byName.get('TODO').line_start, 17)

  const helperEntries = toObjects(index.query(
    "SELECT name, kind FROM entries WHERE path = 'src/helper.js' ORDER BY line_start",
  ))
  assert.deepEqual(helperEntries, [
    { name: 'helper', kind: 'function' },
    { name: 'HELPER_VERSION', kind: 'export' },
  ])

  const pythonEntries = toObjects(index.query(
    "SELECT name, kind, parent, line_start FROM entries WHERE path = 'lib/parser.py' ORDER BY line_start",
  ))
  assert.deepEqual(pythonEntries, [
    { name: 'Parser', kind: 'class', parent: null, line_start: 1 },
    { name: 'parse', kind: 'method', parent: 'Parser', line_start: 2 },
    { name: 'load', kind: 'function', parent: null, line_start: 5 },
  ])

  const goEntries = toObjects(index.query(
    "SELECT name, kind, parent, line_start FROM entries WHERE path = 'go/main.go' ORDER BY line_start",
  ))
  assert.deepEqual(goEntries, [
    { name: 'Server', kind: 'type', parent: null, line_start: 3 },
    { name: 'NewServer', kind: 'function', parent: null, line_start: 7 },
    { name: 'Start', kind: 'method', parent: 'Server', line_start: 11 },
  ])

  const headings = toObjects(index.query(
    "SELECT name, line_start, line_end, meta FROM entries WHERE path = 'README.md' ORDER BY line_start",
  ))
  assert.deepEqual(headings.map((heading) => [heading.name, heading.line_start, heading.line_end]), [
    ['CostPilot Index', 1, 4],
    ['Usage', 5, 8],
    ['Example', 9, 12],
  ])
  assert.equal(JSON.parse(headings[0].meta).level, 1)
  assert.equal(JSON.parse(headings[2].meta).level, 3)

  const todos = toObjects(index.query("SELECT name, path FROM entries WHERE kind = 'todo' ORDER BY path"))
  assert.deepEqual(todos, [
    { name: 'FIXME', path: 'notes/todo.txt' },
    { name: 'TODO', path: 'src/app.ts' },
  ])
})

test('m4: reuses an existing database across two createIndex instances', (t) => {
  const root = makeWorkspace(t)
  const first = makeIndex(t, root)
  const build = first.ensureFresh()
  const dbPath = first.stats().dbPath
  assert.equal(first.query('SELECT COUNT(*) AS n FROM files').rows[0][0], FIXTURE_FILES.length)
  first.close()

  const second = makeIndex(t, root)
  const reuse = second.ensureFresh()
  assert.equal(reuse.built, false)
  assert.equal(reuse.indexed, 0)
  assert.equal(reuse.files, build.files)
  assert.equal(reuse.entries, build.entries)
  assert.equal(reuse.builtAt, build.builtAt)
  assert.equal(second.stats().dbPath, dbPath)
  assert.equal(second.query('SELECT COUNT(*) AS n FROM files').rows[0][0], FIXTURE_FILES.length)
})

test('m4: incremental refresh only reindexes files whose mtime/size changed', (t) => {
  const root = makeWorkspace(t)
  const index = makeIndex(t, root)
  index.ensureFresh()
  const helperBefore = toObjects(index.query(
    "SELECT path, mtime, size FROM files WHERE path = 'src/helper.js'",
  ))[0]

  const appPath = path.join(root, 'src', 'app.ts')
  fs.writeFileSync(appPath, 'export function onlyNow() {}\n')
  const result = index.ensureFresh()

  assert.equal(result.built, true)
  assert.equal(result.indexed, 1)
  assert.equal(result.files, FIXTURE_FILES.length)
  const appNames = index.query("SELECT name FROM entries WHERE path = 'src/app.ts'").rows.map((row) => row[0])
  assert.deepEqual(appNames, ['onlyNow'])
  const helperAfter = toObjects(index.query(
    "SELECT path, mtime, size FROM files WHERE path = 'src/helper.js'",
  ))[0]
  assert.deepEqual(helperAfter, helperBefore, 'untouched file must not be reindexed')
})

test('m4: markDirty forces a rebuild even with identical mtime and size', (t) => {
  const root = makeWorkspace(t, { 'a.ts': 'export const A = 1\n' })
  const file = path.join(root, 'a.ts')
  // Pin a whole-millisecond mtime so it can be restored exactly below.
  const pinned = new Date(1700000000000)
  fs.utimesSync(file, pinned, pinned)

  const index = makeIndex(t, root)
  index.ensureFresh()

  fs.writeFileSync(file, 'export const B = 1\n')
  fs.utimesSync(file, pinned, pinned)

  // mtime/size are unchanged: a plain scan must not rebuild.
  assert.equal(fs.statSync(file).mtimeMs, pinned.getTime())
  assert.equal(index.ensureFresh().built, false)
  assert.deepEqual(index.query("SELECT name FROM entries WHERE path = 'a.ts'").rows[0], ['A'])

  assert.equal(index.markDirty(['a.ts']), 1)
  assert.equal(index.stats().dirty, 1)
  const rebuilt = index.ensureFresh()
  assert.equal(rebuilt.built, true)
  assert.equal(rebuilt.indexed, 1)
  assert.equal(index.stats().dirty, 0)
  assert.deepEqual(index.query("SELECT name FROM entries WHERE path = 'a.ts'").rows[0], ['B'])
})

test('m4: markDirty expands directories and accepts absolute paths', (t) => {
  const root = makeWorkspace(t, {
    'src/x.ts': 'export const X = 1\n',
    'src/nested/y.ts': 'export const Y = 1\n',
    'root.md': '# Root\n',
  })
  const index = makeIndex(t, root)
  index.ensureFresh()

  assert.equal(index.markDirty(['src']), 2)
  assert.equal(index.stats().dirty, 2)
  assert.equal(index.markDirty([path.join(root, 'root.md')]), 1)
  assert.equal(index.stats().dirty, 3)

  const result = index.ensureFresh()
  assert.equal(result.built, true)
  assert.equal(index.stats().dirty, 0)
})

test('m4: ignores ignoreDirs, exclude globs and binary files', (t) => {
  const root = makeWorkspace(t)
  const index = makeIndex(t, root)
  index.ensureFresh()

  const paths = index.query('SELECT path FROM files ORDER BY path').rows.map((row) => row[0])
  assert.deepEqual(paths, FIXTURE_FILES)
  for (const foreign of ['node_modules/pkg/index.js', '.git/config', 'build/out.js', 'secret.pem', '.env', 'assets/blob.bin']) {
    assert.equal(paths.includes(foreign), false, foreign + ' must not be indexed')
  }
})

test('m4: honors maxFileBytes', (t) => {
  const root = makeWorkspace(t, {
    'small.md': '# Small\n',
    'big.md': 'x'.repeat(500),
  })
  const index = makeIndex(t, root, { config: configWith({ maxFileBytes: 64 }) })
  const result = index.ensureFresh()
  assert.equal(result.files, 1)
  assert.deepEqual(index.query('SELECT path FROM files').rows, [['small.md']])
})

test('m4: caps the number of files at maxFiles and flags stale', (t) => {
  const root = makeWorkspace(t, {
    'a.md': '# A\n',
    'b.md': '# B\n',
    'c.md': '# C\n',
    'd.md': '# D\n',
  })
  const limited = makeIndex(t, root, { config: configWith({ maxFiles: 2 }) })
  const first = limited.ensureFresh()
  assert.equal(first.files, 2)
  assert.equal(first.indexed, 2)
  assert.equal(first.stale, true)
  assert.deepEqual(limited.query('SELECT path FROM files ORDER BY path').rows.map((row) => row[0]), ['a.md', 'b.md'])
  limited.close()

  const full = makeIndex(t, root, { config: configWith({ maxFiles: 100 }) })
  const second = full.ensureFresh()
  assert.equal(second.files, 4)
  assert.equal(second.indexed, 2)
  assert.equal(second.stale, false)
})

test('m4: rejects writes, multi-statements, comments and non-SELECT SQL', (t) => {
  const root = makeWorkspace(t)
  const index = makeIndex(t, root)
  index.ensureFresh()

  const invalid = [
    "INSERT INTO files(path) VALUES ('x')",
    "UPDATE files SET name = 'x'",
    'DELETE FROM entries',
    'DROP TABLE files',
    'ALTER TABLE files ADD COLUMN extra TEXT',
    'CREATE TABLE evil (a TEXT)',
    "REPLACE INTO meta(key, value) VALUES ('x', 'y')",
    'VACUUM',
    'PRAGMA table_info(files)',
    "ATTACH DATABASE ':memory:' AS other",
    'DETACH DATABASE other',
    'SELECT * FROM files; DROP TABLE files',
    'SELECT 1; SELECT 2',
    'SELECT * FROM files -- comment',
    'SELECT * FROM files /* comment */',
    'WITH x AS (SELECT 1) SELECT * FROM x',
    '   ',
  ]
  for (const sql of invalid) {
    assert.throws(
      () => index.query(sql),
      (error) => error instanceof Error && /index_query/.test(error.message),
      'expected rejection: ' + sql,
    )
  }
  // A single trailing semicolon is still a single statement.
  assert.equal(index.query('SELECT COUNT(*) AS n FROM files;').rows[0][0], FIXTURE_FILES.length)
  assert.equal(index.query('select count(*) as n from meta').rows[0][0] >= 3, true)
})

test('m4: caps result rows at maxRows and reports truncation', (t) => {
  const root = makeWorkspace(t)
  const index = makeIndex(t, root, { config: configWith({ maxRows: 3 }) })
  index.ensureFresh()

  const capped = index.query('SELECT path FROM files ORDER BY path')
  assert.equal(capped.rows.length, 3)
  assert.equal(capped.truncated, true)

  const exact = index.query('SELECT path FROM files ORDER BY path LIMIT 3')
  assert.equal(exact.rows.length, 3)
  assert.equal(exact.truncated, false)

  const under = index.query('SELECT path FROM files ORDER BY path LIMIT 2')
  assert.equal(under.rows.length, 2)
  assert.equal(under.truncated, false)
})

test('m4: SQL errors are Errors whose message locates the query', (t) => {
  const root = makeWorkspace(t)
  const index = makeIndex(t, root)
  index.ensureFresh()

  assert.throws(
    () => index.query('SELECT missing_column FROM files'),
    (error) => error instanceof Error
      && /index_query: SQL error/.test(error.message)
      && /missing_column/.test(error.message)
      && /sql: SELECT missing_column FROM files/.test(error.message),
  )
  assert.equal(validateReadOnlySql('SELECT 1').ok, true)
  assert.equal(validateReadOnlySql('delete from files').ok, false)
  assert.match(validateReadOnlySql('delete from files').reason, /SELECT|forbidden/i)
})

test('m4: lazily builds the index when query runs before ensureFresh', (t) => {
  const root = makeWorkspace(t)
  const index = makeIndex(t, root)
  assert.equal(index.stats().builtAt, null)

  const result = index.query('SELECT COUNT(*) AS n FROM files')
  assert.equal(result.rows[0][0], FIXTURE_FILES.length)
  assert.notEqual(index.stats().builtAt, null)
})

test('m4: rebuilds after the database file is deleted', (t) => {
  const root = makeWorkspace(t)
  const index = makeIndex(t, root)
  index.ensureFresh()
  const dbPath = index.stats().dbPath
  fs.rmSync(dbPath)

  const result = index.query('SELECT COUNT(*) AS n FROM files')
  assert.equal(result.rows[0][0], FIXTURE_FILES.length)
  assert.ok(fs.existsSync(dbPath), 'query must recreate the database file')
  assert.notEqual(index.stats().builtAt, null)
})

test('m4: errors on a missing workspace instead of wiping the index', (t) => {
  const missing = path.join(os.tmpdir(), 'costpilot-m4-missing-' + process.pid + '-' + Date.now())
  assert.throws(() => createIndex({ root: missing }), /workspace root does not exist/)

  const root = makeWorkspace(t)
  const index = makeIndex(t, root)
  index.ensureFresh()
  fs.rmSync(root, { recursive: true, force: true })
  assert.throws(() => index.ensureFresh(), /workspace root is not accessible/)
  assert.throws(() => index.query('SELECT * FROM files'), /workspace root is not accessible/)
})

test('m4: schema version mismatch triggers a full rebuild', (t) => {
  const root = makeWorkspace(t)
  const first = makeIndex(t, root)
  const build = first.ensureFresh()
  const dbPath = first.stats().dbPath
  first.close()

  const db = new DatabaseSync(dbPath)
  db.prepare("UPDATE meta SET value = '0' WHERE key = 'schema_version'").run()
  db.close()

  const second = makeIndex(t, root)
  const rebuilt = second.ensureFresh()
  assert.equal(rebuilt.built, true)
  assert.equal(rebuilt.files, build.files)
  assert.equal(rebuilt.indexed, build.files)
  const version = second.query("SELECT value FROM meta WHERE key = 'schema_version'").rows[0][0]
  assert.equal(version, String(SCHEMA_VERSION))
})

test('m4: workspace root mismatch triggers a full rebuild for the new root', (t) => {
  const rootA = makeWorkspace(t)
  const rootB = makeWorkspace(t, { 'other/b.md': '# Other\n' })
  const first = makeIndex(t, rootA)
  first.ensureFresh()
  const sharedDb = first.stats().dbPath
  first.close()

  const second = makeIndex(t, rootB, { dbPath: sharedDb })
  const rebuilt = second.ensureFresh()
  assert.equal(rebuilt.built, true)
  assert.equal(rebuilt.files, 1)
  assert.deepEqual(second.query('SELECT path FROM files').rows, [['other/b.md']])
  assert.equal(second.stats().root, path.resolve(rootB))
})

// ---------------------------------------------------------------- tool

test('m4: index_query ToolDefinition matches the DSH shape and executes', async (t) => {
  const root = makeWorkspace(t)
  const index = makeIndex(t, root)
  index.ensureFresh()
  const tool = createIndexTool({ index, config: configWith({ maxRows: 200 }) })

  assert.equal(tool.name, INDEX_TOOL_NAME)
  assert.equal(tool.name, 'index_query')
  assert.equal(typeof tool.description, 'string')
  assert.match(tool.description, /files\(path/)
  assert.match(tool.description, /entries\(path/)
  assert.match(tool.description, /SELECT/)
  assert.match(tool.description, /read-only/i)
  assert.match(tool.description, /200 rows/)

  assert.equal(tool.parameters.type, 'object')
  assert.deepEqual(tool.parameters.required, ['sql'])
  assert.equal(tool.parameters.additionalProperties, false)
  assert.equal(tool.parameters.properties.sql.type, 'string')

  assert.deepEqual(tool.output.schema, {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  })
  assert.equal(typeof tool.output.render, 'function')
  assert.equal(typeof tool.execute, 'function')

  const result = await tool.execute({ sql: 'SELECT path, language FROM files ORDER BY path' })
  assert.equal(typeof result.text, 'string')
  assert.match(result.text, /index_query: 6 rows/)
  assert.match(result.text, /\| path \| language \|/)
  assert.match(result.text, /\| src\/app\.ts \| typescript \|/)
  assert.match(result.text, /truncated=false/)

  const blocks = tool.output.render({ sql: 'ignored' }, result)
  assert.deepEqual(blocks, [{ type: 'text', text: result.text }])

  assert.equal(formatIndexResult({ columns: ['a'], rows: [], ms: 0, truncated: false }).includes('(no rows)'), true)

  await assert.rejects(() => tool.execute({}), /index_query/)
  await assert.rejects(() => tool.execute({ sql: 42 }), /index_query/)
  await assert.rejects(() => tool.execute({ sql: '   ' }), /index_query/)
  await assert.rejects(() => tool.execute({ sql: 'DELETE FROM files' }), /index_query/)
  await assert.rejects(() => tool.execute({ sql: 'SELECT * FROM files; DROP TABLE files' }), /index_query/)
})

test('m4: index_query works before an explicit ensureFresh', async (t) => {
  const root = makeWorkspace(t)
  const index = makeIndex(t, root)
  const tool = createIndexTool({ index })
  const result = await tool.execute({ sql: "SELECT COUNT(*) AS n FROM entries WHERE kind = 'heading'" })
  assert.match(result.text, /\| 3 \|/)
})

// ---------------------------------------------------------------- pure

test('m4: detectLanguage maps extensions and extractEntries is 1-based', () => {
  assert.equal(detectLanguage('a/b.ts'), 'typescript')
  assert.equal(detectLanguage('a/b.mjs'), 'javascript')
  assert.equal(detectLanguage('a/b.py'), 'python')
  assert.equal(detectLanguage('a/b.go'), 'go')
  assert.equal(detectLanguage('a/b.md'), 'markdown')
  assert.equal(detectLanguage('a/b.txt'), 'text')

  const entries = extractEntries({ path: 'x.ts', content: 'export function top() {\n  return 1\n}\n' })
  assert.deepEqual(entries, [
    { name: 'top', kind: 'function', parent: null, line_start: 1, line_end: 1, meta: null },
  ])
})
