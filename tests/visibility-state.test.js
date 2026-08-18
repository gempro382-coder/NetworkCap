const assert = require('node:assert/strict');
const { shouldRestoreFromHide } = require('../src/core/visibility-state');

assert.equal(shouldRestoreFromHide({ inOverlayMode: true, suppressRestoreOnHide: false, overlayVisible: true }), true, 'should restore after external hide while overlay mode is active');
assert.equal(shouldRestoreFromHide({ inOverlayMode: true, suppressRestoreOnHide: true, overlayVisible: true }), false, 'should not restore after user-initiated hide');
assert.equal(shouldRestoreFromHide({ inOverlayMode: true, suppressRestoreOnHide: false, overlayVisible: false }), false, 'should ignore restore when the overlay is intentionally hidden');
assert.equal(shouldRestoreFromHide({ inOverlayMode: false, suppressRestoreOnHide: true, overlayVisible: true }), false, 'should ignore restore when overlay mode is off');

console.log('visibility-state tests: pass');
