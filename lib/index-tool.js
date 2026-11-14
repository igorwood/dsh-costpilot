/**
 * M4: the index_query ToolDefinition.
 *
 * Exposes the local SQLite workspace index to the model as one read-only tool.
 * The tool shape follows the DSH contracts (research/tmp/api-catalog.js):
 *
 *   ToolDefinition extends ToolSchema { name, description, parameters }
 *   ToolDefinition.output: { schema: JsonSchemaNode, render(args, value): ContentBlock[] }
 *   ToolDefinition.execute(args, exec): Promise<unknown>
 *
 * Errors are thrown: the DSH tool executor turns them into an error result, and
 * the message always carries the index_query prefix plus the offending SQL.
 *
 * @module dsh-costpilot/lib/index-tool
 */
import { DEFAULTS } from './config.js'

/** Tool name registered with ctx.tools. */
export const INDEX_TOOL_NAME = 'index_query'

const CELL_MAX_CHARS = 120

function positiveInteger(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 1 ? Math.floor(number) : fallback
}

function resolveMaxRows(config) {
  const moduleConfig = config?.modules?.M4
  if (moduleConfig && typeof moduleConfig === 'object') {
    return positiveInteger(moduleConfig.maxRows, DEFAULTS.modules.M4.maxRows)
  }
  if (config && typeof config === 'object' && typeof config.maxRows === 'number') {
    return positiveInteger(config.maxRows, DEFAULTS.modules.M4.maxRows)
  }
  return DEFAULTS.modules.M4.maxRows
}

function formatCell(value) {
  if (value === null || value === undefined) return 'NULL'
  let text
  if (typeof value === 'string') text = value
  else if (typeof value === 'object') {
    try { text = JSON.stringify(value) } catch { text = String(value) }
  } else text = String(value)
  text = text.replace(/\r\n|\r|\n/g, ' ').replace(/\|/g, '\\|')
  return text.length > CELL_MAX_CHARS ? text.slice(0, CELL_MAX_CHARS - 3) + '...' : text
}

/**
 * Render one query result as compact pipe-table text.
 *
 * @param {{columns?: string[], rows?: unknown[][], ms?: number, truncated?: boolean}} result
 * @returns {string}
 */
export function formatIndexResult(result) {
  const columns = Array.isArray(result?.columns) ? result.columns.map((column) => String(column)) : []
  const rows = Array.isArray(result?.rows) ? result.rows : []
  const ms = Number.isFinite(result?.ms) ? result.ms : 0
  const truncated = result?.truncated === true
  const header = 'index_query: ' + rows.length + ' row' + (rows.length === 1 ? '' : 's')
    + ' | ' + ms + ' ms | truncated=' + truncated
  const lines = [header]
  if (columns.length === 0) {
    lines.push('(no columns)')
    return lines.join('\n')
  }
  lines.push('| ' + columns.map(formatCell).join(' | ') + ' |')
  lines.push('| ' + columns.map(() => '---').join(' | ') + ' |')
  if (rows.length === 0) {
    lines.push('(no rows)')
    return lines.join('\n')
  }
  for (const row of rows) {
    const cells = Array.isArray(row) ? row : [row]
    lines.push('| ' + cells.map(formatCell).join(' | ') + ' |')
  }
  if (truncated) lines.push('... row limit reached; narrow the query with WHERE or LIMIT')
  return lines.join('\n')
}

/**
 * Build the index_query tool definition.
 *
 * @param {{ index: {query: (sql: string) => {columns: string[], rows: unknown[][], ms: number, truncated: boolean}}, config?: object }} options
 * @returns {object} ToolDefinition
 */
export function createIndexTool({ index, config } = {}) {
  if (!index || typeof index.query !== 'function') {
    throw new TypeError('createIndexTool requires { index } with a query() method')
  }
  const maxRows = resolveMaxRows(config)

  const description = [
    'Run one read-only SQL query against the local workspace index (files, symbols, headings, TODOs).',
    '',
    'Tables:',
    '  files(path TEXT, name TEXT, language TEXT, lines INTEGER, mtime REAL, size INTEGER)',
    '  entries(path TEXT, name TEXT, kind TEXT, parent TEXT, line_start INTEGER, line_end INTEGER, meta TEXT)',
    '  meta(key TEXT, value TEXT)',
    '',
    'Useful kinds: import, export, class, function, method, interface, type, heading, todo.',
    'Prefer this over reading many files when locating where something is defined.',
    '',
    'Examples:',
    '  SELECT path, language, lines FROM files ORDER BY lines DESC LIMIT 10',
    "  SELECT path, name, kind, line_start FROM entries WHERE kind = 'function' AND name LIKE 'handle%'",
    "  SELECT path, name, line_start FROM entries WHERE kind = 'todo' ORDER BY path",
    "  SELECT path, name, parent FROM entries WHERE kind = 'method' AND parent = 'Widget'",
    '',
    'Rules: exactly one SELECT statement; no semicolons mid-statement, comments,',
    'PRAGMA/ATTACH or any write statement. Results are capped at ' + maxRows + ' rows;',
    'add WHERE/LIMIT to stay under the cap. Results are returned as a compact table.',
  ].join('\n')

  return {
    name: INDEX_TOOL_NAME,
    description,
    parameters: {
      type: 'object',
      properties: {
        sql: {
          type: 'string',
          description: 'Single read-only SELECT statement over files, entries or meta.',
        },
      },
      required: ['sql'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
      render(_args, value) {
        return [{ type: 'text', text: typeof value?.text === 'string' ? value.text : '' }]
      },
    },
    async execute(args, _exec) {
      if (!args || typeof args !== 'object' || Array.isArray(args)) {
        throw new Error('index_query: args must be an object with a "sql" string')
      }
      const sql = args.sql
      if (typeof sql !== 'string' || sql.trim().length === 0) {
        throw new Error('index_query: args.sql must be a non-empty string')
      }
      let result
      try {
        result = index.query(sql)
      } catch (error) {
        throw error instanceof Error ? error : new Error('index_query: ' + String(error))
      }
      return { text: formatIndexResult(result) }
    },
  }
}
