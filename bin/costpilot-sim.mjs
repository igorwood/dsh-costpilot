#!/usr/bin/env node
/**
 * costpilot-sim: offline report over CostPilot ledgers.
 * Usage: costpilot-sim [--dir <sessions-dir>] [--session <id>] [--json]
 */
import os from 'node:os'
import path from 'node:path'
import { renderReport } from '../lib/sim.js'

const args = process.argv.slice(2)
const options = { json: false }
for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (arg === '--json') options.json = true
  else if (arg === '--dir') options.dir = args[++i]
  else if (arg === '--session') options.sessionId = args[++i]
  else if (arg === '--help' || arg === '-h') {
    console.log('usage: costpilot-sim [--dir <sessions-dir>] [--session <id>] [--json]')
    process.exit(0)
  } else {
    console.error('unknown argument: ' + arg)
    process.exit(2)
  }
}

const dir = options.dir
  ?? path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'costpilot', 'sessions')
console.log(renderReport(dir, options))
