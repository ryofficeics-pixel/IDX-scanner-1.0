'use strict';

module.exports = Object.freeze({
  historyCandidateLimit: 72,
  minimumTradedValue: 5e8,
  scoreWeights: Object.freeze({ setup:0.32, trigger:0.32, confirmation:0.24, entry:0.12 }),
  thresholds: Object.freeze({ setup:52, armed:60, trigger:58, buy:66, strongBuy:85 }),
  earlyDemand: Object.freeze({ minimumAtrPct:5, exceptionalVolumeAcceleration:3, exceptionalPriceAcceleration:0.10,
    compressionScore:60, confirmationScore:72, relativeVolume:1.3, localVolumeAcceleration:2,
    rangePosition:0.65, minimumChangePct:0.5, priceVelocity:0.10, volumeAcceleration:1.3, relativeVolumeAcceleration:0.10 }),
  backtest: Object.freeze({
    buyFeePct:0.15,
    sellFeePct:0.25,
    slippagePct:Object.freeze({ high:0.10, medium:0.25, low:0.50 }),
    liquidityValue:Object.freeze({ high:2e10, medium:5e9 }),
    targetPct:3,
    stopPct:2,
  }),
});
