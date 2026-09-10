'use strict';

async function withTimeout(label, ms, task) {
  let timer;
  try {
    return await Promise.race([task(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}_TIMEOUT`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

function providerBudget(ms = 45000) {
  const deadline = Date.now() + ms;
  return (label, timeoutMs, task) => Date.now() >= deadline
    ? Promise.reject(new Error('SCAN_PROVIDER_BUDGET_EXHAUSTED'))
    : withTimeout(label, Math.min(timeoutMs, deadline - Date.now()), task);
}

module.exports = { withTimeout, providerBudget };
