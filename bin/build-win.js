'use strict';

// Keep the Windows portable build reproducible without requiring the very
// large memory allocation used by electron-builder's default level-9 7-Zip
// settings. Level 7 + BCJ still compresses Electron well; a tiny proxy also
// caps 7-Zip at one thread and a 32 MiB dictionary in small CI VMs.
const { chmodSync } = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { getPath7za } = require('app-builder-lib/out/toolsets/7zip');

async function main() {
  const cli = require.resolve('electron-builder/out/cli/cli.js');
  const proxy7za = path.join(__dirname, '7za-low-memory.js');
  chmodSync(proxy7za, 0o755);
  const real7za = await getPath7za();
  const args = [cli, '--win', 'portable', '--x64', ...process.argv.slice(2)];
  const env = {
    ...process.env,
    ELECTRON_BUILDER_COMPRESSION_LEVEL: process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL || '7',
    ELECTRON_BUILDER_7Z_FILTER: process.env.ELECTRON_BUILDER_7Z_FILTER || 'BCJ',
    ELECTRON_BUILDER_7ZIP_PATH: proxy7za,
    AASHI_REAL_7ZIP_PATH: real7za
  };

  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    env,
    stdio: 'inherit'
  });

  if (result.error) {
    console.error(`Windows build failed to start: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status == null ? 1 : result.status);
}

main().catch((error) => {
  console.error(`Windows build setup failed: ${error.message}`);
  process.exit(1);
});
