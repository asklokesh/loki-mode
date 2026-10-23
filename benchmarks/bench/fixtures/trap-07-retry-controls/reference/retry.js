const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function retry(fn, { retries = 3, delayMs = 100, sleep = realSleep } = {}) {
  let wait = delayMs;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= retries) throw err;
      await sleep(wait);
      wait *= 2;
    }
  }
}

module.exports = { retry };
