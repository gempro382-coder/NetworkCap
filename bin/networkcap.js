#!/usr/bin/env node
'use strict';

/**
 * NetworkCap — CLI wizard.
 * Author: Aashish <aashish@aashi.ai> — https://aashi.ai — @Aashish
 *
 *   aashi setup        Collect Groq + Gemini API keys
 *   aashi doctor       Verify the environment (keys + connectivity)
 *   aashi start        Launch the desktop app
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { spawn } = require('child_process');

const { APP_NAME, APP_AUTHOR, APP_AUTHOR_EMAIL, APP_AUTHOR_URL, APP_AUTHOR_HANDLE, PATHS } = require('../src/shared/constants');

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m',
  red: '\x1b[31m', magenta: '\x1b[35m', blue: '\x1b[34m'
};

const BANNER = `NetworkCap v5.0
Cloud AI interview assistant (Groq Whisper STT + 3-tier LLM routing)
by ${APP_AUTHOR} - ${APP_AUTHOR_EMAIL} - ${APP_AUTHOR_URL} - ${APP_AUTHOR_HANDLE}`;

const ok = (m) => console.log(`${C.green}✓${C.reset} ${m}`);
const warn = (m) => console.log(`${C.yellow}⚠${C.reset} ${m}`);
const bad = (m) => console.log(`${C.red}✕${C.reset} ${m}`);
const info = (m) => console.log(`${C.cyan}▸${C.reset} ${m}`);
const dim = (m) => console.log(`${C.dim}  ${m}${C.reset}`);

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { args.flags[key] = next; i++; }
      else args.flags[key] = true;
    } else args._.push(a);
  }
  return args;
}

function ensureDirs() {
  for (const d of [PATHS.root, PATHS.logs, PATHS.cache]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch (_) { /* ignore */ }
  }
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(PATHS.config, 'utf8')); } catch (_) { return {}; }
}

function writeConfig(patch) {
  ensureDirs();
  const cfg = { ...readConfig(), ...patch };
  fs.writeFileSync(PATHS.config, JSON.stringify(cfg, null, 2));
  try { fs.chmodSync(PATHS.config, 0o600); } catch (_) { /* windows */ }
  return cfg;
}

function ask(question, { silent = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (!silent) return rl.question(question, (a) => { rl.close(); resolve(a.trim()); });
    const onData = (ch) => {
      const s = ch.toString();
      if (['\n', '\r', '\u0004'].includes(s)) process.stdin.removeListener('data', onData);
      else process.stdout.write('*');
    };
    process.stdout.write(question);
    process.stdin.on('data', onData);
    rl.question('', (a) => {
      rl.close();
      process.stdout.write('\n');
      resolve(a.trim());
    });
  });
}

async function cmdSetup() {
  console.log(BANNER);
  const cfg = readConfig();
  info('NetworkCap needs two API keys — Groq (STT + fast LLM tiers) and Gemini (hard tier + fallback).');
  dim('Groq:      https://console.groq.com/keys');
  dim('Gemini:    https://aistudio.google.com/apikey');
  let groq = cfg.groqApiKey || process.env.GROQ_API_KEY || '';
  let gemini = cfg.geminiApiKey || process.env.GEMINI_API_KEY || '';
  if (process.stdin.isTTY) {
    if (!groq) groq = await ask(`${C.cyan}?${C.reset} Groq API key: `, { silent: true });
    if (!gemini) gemini = await ask(`${C.cyan}?${C.reset} Gemini API key: `, { silent: true });
  } else {
    dim('Non-interactive: set GROQ_API_KEY and GEMINI_API_KEY (or pre-create ~/.aashi/config.json).');
  }
  writeConfig({ groqApiKey: groq, geminiApiKey: gemini });
  if (groq && gemini) ok('Both keys saved to ~/.aashi/config.json (chmod 600).');
  else warn('Saved what was provided — add the rest in the app setup screen.');
  console.log(`\n${C.green}${C.bold}Setup complete.${C.reset} Launch with: ${C.cyan}aashi start${C.reset}\n`);
  return 0;
}

async function cmdDoctor() {
  console.log(BANNER);
  const cfg = readConfig();
  let issues = 0;
  fs.existsSync(PATHS.root) ? ok(`Data dir ${PATHS.root}`) : (bad('Data dir missing'), issues++);
  cfg.groqApiKey || process.env.GROQ_API_KEY ? ok('Groq API key configured') : (bad('Groq API key missing'), issues++);
  cfg.geminiApiKey || process.env.GEMINI_API_KEY ? ok('Gemini API key configured') : (bad('Gemini API key missing'), issues++);
  console.log(issues === 0 ? `\n${C.green}${C.bold}All checks passed.${C.reset}\n` : `\n${C.yellow}${issues} issue(s) found.${C.reset}\n`);
  return issues === 0 ? 0 : 1;
}

async function cmdStart() {
  const root = path.join(__dirname, '..');
  let electronBin;
  try { electronBin = require('electron'); } catch (_) { electronBin = null; }
  if (!electronBin) { bad('Electron not installed. Run: npm install'); return 1; }
  const child = spawn(electronBin, [root], { stdio: 'inherit', windowsHide: false });
  return new Promise((resolve) => child.on('exit', (code) => resolve(code || 0)));
}

function usage() {
  console.log(BANNER);
  console.log(`${C.bold}Usage${C.reset}
  aashi setup     Collect Groq + Gemini API keys
  aashi doctor     Verify the environment
  aashi start      Launch the desktop app

${C.bold}Recommended first run${C.reset}
  ${C.cyan}aashi setup${C.reset}
`);
}

(async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'help';
  let code = 0;
  try {
    switch (cmd) {
      case 'setup': code = await cmdSetup(); break;
      case 'doctor': code = await cmdDoctor(); break;
      case 'start': code = await cmdStart(); break;
      default: usage(); code = 0;
    }
  } catch (err) {
    bad(err.message);
    code = 1;
  }
  process.exit(code);
})();
