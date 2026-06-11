'use strict';

function wibDate(now = new Date()) {
  return new Date(now.toLocaleString('en-US', { timeZone:'Asia/Jakarta' }));
}

function minutes(d) {
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
}

function volumeCurve(progress) {
  const p = Math.max(0, Math.min(1, Number(progress) || 0));
  return Math.max(0, Math.min(1, 0.28 * Math.sqrt(p) + 0.72 * Math.pow(p, 1.35)));
}

function sessionContext(now = new Date()) {
  const wib = wibDate(now);
  const day = wib.getDay();
  const m = minutes(wib);
  if (day < 1 || day > 5) {
    return { status:'CLOSED', sessionProgress:0, expectedVolumeProgress:0, timezone:'Asia/Jakarta' };
  }
  const friday = day === 5;
  const s1Start = 9 * 60;
  const s1End = friday ? 11 * 60 + 30 : 12 * 60;
  const s2Start = friday ? 14 * 60 : 13 * 60 + 30;
  const s2End = 15 * 60 + 49 + 59 / 60;
  let status = 'CLOSED';
  if (m < s1Start) status = 'PRE_OPEN';
  else if (m <= s1End) status = 'MORNING';
  else if (m < s2Start) status = 'LUNCH_BREAK';
  else if (m <= s2End - 10) status = 'AFTERNOON';
  else if (m <= s2End) status = 'PRE_CLOSE';

  const tradingElapsed = Math.max(0, Math.min(m, s1End) - s1Start)
    + Math.max(0, Math.min(m, s2End) - s2Start);
  const totalTrading = (s1End - s1Start) + (s2End - s2Start);
  const sessionProgress = Math.max(0, Math.min(1, tradingElapsed / totalTrading));
  return {
    status,
    sessionProgress,
    expectedVolumeProgress: volumeCurve(sessionProgress),
    timezone:'Asia/Jakarta',
  };
}

function inMorningBuyWindow(now = new Date()) {
  const m = minutes(wibDate(now));
  return m >= 9 * 60 && m <= 10 * 60 + 30;
}

function inAfternoonBuyWindow(now = new Date()) {
  const m = minutes(wibDate(now));
  return m >= 14 * 60 + 30 && m <= 15 * 60 + 49 + 59 / 60;
}

module.exports = { sessionContext, inMorningBuyWindow, inAfternoonBuyWindow };
