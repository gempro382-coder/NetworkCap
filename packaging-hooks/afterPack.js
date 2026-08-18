'use strict';

// Keep English plus the user's likely regional languages. Removing unused
// Chromium locale packs is a packaging optimization only; it does not alter
// process visibility or operating-system controls.
const fs = require('fs');
const path = require('path');

module.exports = async function afterPack(context) {
  const locales = path.join(context.appOutDir, 'locales');
  if (!fs.existsSync(locales)) return;
  const keep = new Set(['en-US.pak', 'en-GB.pak', 'hi.pak', 'bn.pak']);
  for (const file of fs.readdirSync(locales)) {
    if (!keep.has(file)) {
      try { fs.unlinkSync(path.join(locales, file)); } catch (_) { /* non-fatal */ }
    }
  }
};
