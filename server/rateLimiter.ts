/**
 * In-process fixed-window rate limiter.
 *
 * Dependency-free limiter for the public API (gap-closure plan WS-2/WS-4;
 * tech-debt item "no rate limiting on public API endpoints" — also a PCI DSS
 * control). Keyed by API key (preferred) or client IP.
 *
 * Scope note: per-instance state. Correct for the current single-instance
 * Railway deployment and on-prem installs; when the platform scales to
 * multiple instances behind a load balancer, move the counters to Redis
 * (arrives with the BullMQ queue — see docs/GAP_CLOSURE_PLAN.md WS-4 pre-work).
 */

export interface RateLimitResult {
  allowed: boolean;
  /** Requests left in the current window (0 when blocked). */
  remaining: number;
  /** Seconds until the current window resets (ceil). */
  retryAfterSec: number;
}

interface WindowEntry {
  count: number;
  windowStart: number;
}

export interface RateLimiter {
  check(key: string): RateLimitResult;
  /** Test/ops helper: drop all tracked windows. */
  reset(): void;
}

export function createRateLimiter(options: { windowMs: number; max: number }): RateLimiter {
  const { windowMs, max } = options;
  const windows = new Map<string, WindowEntry>();
  let lastPrune = Date.now();

  // Drop expired windows so the map can't grow unboundedly under key churn.
  function prune(now: number) {
    if (now - lastPrune < windowMs) return;
    lastPrune = now;
    for (const [key, entry] of Array.from(windows.entries())) {
      if (now - entry.windowStart >= windowMs) windows.delete(key);
    }
  }

  return {
    check(key: string): RateLimitResult {
      const now = Date.now();
      prune(now);

      let entry = windows.get(key);
      if (!entry || now - entry.windowStart >= windowMs) {
        entry = { count: 0, windowStart: now };
        windows.set(key, entry);
      }

      const retryAfterSec = Math.max(1, Math.ceil((entry.windowStart + windowMs - now) / 1000));
      if (entry.count >= max) {
        return { allowed: false, remaining: 0, retryAfterSec };
      }
      entry.count += 1;
      return { allowed: true, remaining: max - entry.count, retryAfterSec };
    },
    reset() {
      windows.clear();
    },
  };
}

// ─── Public API limiter (shared instance) ─────────────────────────────

/** 60 requests per minute per API key (or per IP before a key is presented). */
export const PUBLIC_API_RATE_LIMIT = { windowMs: 60_000, max: 60 } as const;

export const publicApiLimiter = createRateLimiter(PUBLIC_API_RATE_LIMIT);

/**
 * Rate-limit key for a public API call: the API key when present (prefix only —
 * never hold full secrets in memory keys), else the client IP.
 */
export function publicApiRateKey(apiKey: string | undefined, ip: string | undefined): string {
  if (apiKey && apiKey.length >= 8) return `key:${apiKey.slice(0, 16)}`;
  return `ip:${ip || "unknown"}`;
}
