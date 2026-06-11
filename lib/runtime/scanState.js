'use strict';

let state = {
  lastSuccessfulScanAt:null,
  lastScanValidCount:0,
  lastScanFailedCount:0,
  lastProviderStatus:'unknown',
  lastCacheStatus:'empty',
};

function updateScanState(next) {
  state = { ...state, ...next };
}

function getScanState() {
  return { ...state };
}

module.exports = { updateScanState, getScanState };
