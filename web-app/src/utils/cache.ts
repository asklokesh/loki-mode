/**
 * Simple in-memory cache with TTL and stale-while-revalidate support.
 *
 * Usage:
 *   const cache = new RequestCache();
 *   const data = await cache.get('templates', () => api.getTemplates(), 300_000);
 */

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

export class RequestCache {
  private store = new Map<string, CacheEntry<unknown>>();
  private inflight = new Map<string, Promise<unknown>>();

  /**
   * Get cached data or fetch fresh. Implements stale-while-revalidate:
   * returns stale data immediately while refreshing in background.
   *
   * @param key - Cache key
   * @param fetcher - Async function to fetch fresh data
   * @param ttl - Time-to-live in milliseconds
   */
  async get<T>(key: string, fetcher: () => Promise<T>, ttl: number): Promise<T> {
    const entry = this.store.get(key) as CacheEntry<T> | undefined;
    const now = Date.now();

    // Fresh cache hit
    if (entry && now - entry.timestamp < entry.ttl) {
      return entry.data;
    }

    // Stale cache exists -- return it but revalidate in background
    if (entry) {
      this.revalidate(key, fetcher, ttl);
      return entry.data;
    }

    // No cache -- fetch synchronously
    return this.fetchAndStore(key, fetcher, ttl);
  }

  /**
   * Invalidate a specific cache key or all keys matching a prefix.
   */
  invalidate(keyOrPrefix: string): void {
    if (this.store.has(keyOrPrefix)) {
      this.store.delete(keyOrPrefix);
      return;
    }
    // Prefix match
    for (const k of this.store.keys()) {
      if (k.startsWith(keyOrPrefix)) {
        this.store.delete(k);
      }
    }
  }

  /**
   * Clear entire cache.
   */
  clear(): void {
    this.store.clear();
  }

  private async fetchAndStore<T>(
    key: string,
    fetcher: () => Promise<T>,
    ttl: number,
  ): Promise<T> {
    // Deduplicate concurrent requests for the same key
    const existing = this.inflight.get(key);
    if (existing) {
      return existing as Promise<T>;
    }

    const promise = fetcher()
      .then((data) => {
        this.store.set(key, { data, timestamp: Date.now(), ttl });
        this.inflight.delete(key);
        return data;
      })
      .catch((err) => {
        this.inflight.delete(key);
        throw err;
      });

    this.inflight.set(key, promise);
    return promise;
  }

  private revalidate<T>(
    key: string,
    fetcher: () => Promise<T>,
    ttl: number,
  ): void {
    if (this.inflight.has(key)) return;

    const promise = fetcher()
      .then((data) => {
        this.store.set(key, { data, timestamp: Date.now(), ttl });
        this.inflight.delete(key);
      })
      .catch(() => {
        this.inflight.delete(key);
      });

    this.inflight.set(key, promise);
  }
}

// Singleton cache instance for the app
export const appCache = new RequestCache();

// Preset TTL constants (milliseconds)
export const CACHE_TTL = {
  TEMPLATES: 5 * 60 * 1000,     // 5 minutes
  PROJECT_LIST: 30 * 1000,       // 30 seconds
  USER_INFO: 5 * 60 * 1000,      // 5 minutes
  STATUS: 10 * 1000,              // 10 seconds
} as const;
