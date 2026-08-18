'use strict';

function shouldRestoreFromHide({ inOverlayMode, suppressRestoreOnHide, overlayVisible }) {
  return Boolean(inOverlayMode && overlayVisible && !suppressRestoreOnHide);
}

module.exports = { shouldRestoreFromHide };
