#!/usr/bin/env node
'use strict';

// electron-builder does not expose 7-Zip's thread limit. Proxy its downloaded
// binary and cap archive creation to one worker with a 32 MiB dictionary so
// portable builds fit inside small CI machines without changing archive format.
const { spawnSync } = require('child_process');

const executable = process.env.AASHI_REAL_7ZIP_PATH;
if (!executable) {
  console.error('AASHI_REAL_7ZIP_PATH is not set.');
  process.exit(2);
}

const args = process.argv.slice(2);
if (args[0] === 'a') {
  if (!args.some((arg) => /^-mmt(?:=|$)/i.test(arg))) args.splice(1, 0, '-mmt=1');
  if (args.some((arg) => /\.7z$/i.test(arg)) && !args.some((arg) => /^-md(?:=|$)/i.test(arg))) {
    args.splice(1, 0, '-md=32m');
  }
}

const result = spawnSync(executable, args, { stdio: 'inherit' });
if (result.error) {
  console.error(`7-Zip failed to start: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status == null ? 1 : result.status);
