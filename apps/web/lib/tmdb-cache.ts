import "server-only";

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6h: TMDB search results barely change

/**
 * The subset of the durable cache the title page's L2 depends on: a namespaced
 * JSON store with a per-entry TTL. Backed by the in-memory variant below (the
 * Postgres-backed implementation was removed when the project went SQLite-only).
 */
export interface DurableJsonCache {
  getJson<T>(key: string): Promise<T | null>;
  setJson(key: string, value: unknown, ttlMs?: number): Promise<void>;
}

/**
 * In-memory `DurableJsonCache` (SQLite-only build has no Postgres to back a
 * durable L2 cache). It is NOT durable — the store resets on every process
 * restart — which is fine: a cold load then pays one live TMDB round-trip (the
 * same trade-off the L1 map already makes), and we avoid adding a second SQLite
 * schema just for a best-effort cache. Expired entries are evicted lazily on read.
 */
export class InMemoryJsonCache implements DurableJsonCache {
  private readonly ttlMs: number;
  private readonly values = new Map<string, { value: unknown; expiresAt: number }>();

  constructor(options?: { ttlMs?: number }) {
    this.ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
  }

  async getJson<T>(key: string): Promise<T | null> {
    const entry = this.values.get(key);
    if (!entry) {
      return null;
    }
    if (entry.expiresAt <= Date.now()) {
      this.values.delete(key);
      return null;
    }
    // Return a fresh clone so a caller mutating the result can't corrupt the cached
    // object (the Postgres-backed cache rehydrated from jsonb on every read — match it).
    return structuredClone(entry.value) as T;
  }

  async setJson(key: string, value: unknown, ttlMs?: number): Promise<void> {
    // Snapshot on write too, so a caller mutating the object AFTER setJson doesn't
    // retroactively change what's cached.
    this.values.set(key, { value: structuredClone(value), expiresAt: Date.now() + (ttlMs ?? this.ttlMs) });
  }
}
