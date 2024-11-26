// Utility function for delay
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

class RateLimiter {
  constructor(tokensPerMinute) {
    this.tokens = tokensPerMinute;
    this.maxTokens = tokensPerMinute;
    this.lastRefill = Date.now();
    this.waitQueue = [];
  }

  async waitForToken() {
    // Add request to queue
    const request = new Promise((resolve, reject) => {
      this.waitQueue.push({ resolve, reject });
    });

    // Process queue if this is the first request
    if (this.waitQueue.length === 1) {
      this.processQueue();
    }

    return request;
  }

  async processQueue() {
    while (this.waitQueue.length > 0) {
      const now = Date.now();
      const timePassed = now - this.lastRefill;
      const refillAmount = Math.floor(timePassed / (60 * 1000) * this.maxTokens);
      
      this.tokens = Math.min(this.maxTokens, this.tokens + refillAmount);
      this.lastRefill = now;

      if (this.tokens < 1) {
        const waitTime = Math.ceil((60 * 1000) / this.maxTokens);
        console.log(`Rate limit reached, waiting ${waitTime/1000} seconds...`);
        await delay(waitTime);
        continue;
      }

      const { resolve } = this.waitQueue.shift();
      this.tokens--;
      resolve(true);
    }
  }
}

// Initialize rate limiter with OpenAI's limit (3 requests per minute)
export const rateLimiter = new RateLimiter(3);
export { delay };