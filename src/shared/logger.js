'use strict';

const fs = require('fs');
const path = require('path');
const { PATHS } = require('./constants');

function ensureDirs() {
  for (const dir of [PATHS.root, PATHS.logs, PATHS.cache]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function clean(value) {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch (_) { return String(value); }
}

function createLogger(scope) {
  ensureDirs();
  const file = path.join(PATHS.logs, 'aashi.log');
  const write = (level, values) => {
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${values.map(clean).join(' ')}\n`;
    try {
      fs.appendFileSync(file, line);
      const stat = fs.statSync(file);
      if (stat.size > 4 * 1024 * 1024) {
        fs.renameSync(file, path.join(PATHS.logs, 'aashi.previous.log'));
      }
    } catch (_) { /* logging must never crash the app */ }
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    fn(line.trimEnd());
  };
  return {
    debug: (...v) => write('debug', v),
    info: (...v) => write('info', v),
    warn: (...v) => write('warn', v),
    error: (...v) => write('error', v)
  };
}

module.exports = { createLogger, ensureDirs };
