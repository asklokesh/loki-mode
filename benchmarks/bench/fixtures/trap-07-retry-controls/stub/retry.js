const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function retry(fn, { retries = 3, delayMs = 100, sleep = realSleep } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      await sleep(delayMs);
    }
  }
  throw lastErr;
}

module.exports = { retry };
