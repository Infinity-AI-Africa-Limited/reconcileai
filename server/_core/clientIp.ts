/**
 * Who the client is — one policy, every call site.
 *
 * `X-Forwarded-For` is an APPEND-only list. Each proxy adds the address it
 * received the connection from, so the RIGHTMOST entries are the ones written
 * by infrastructure we control and everything to their left is whatever the
 * client chose to send. Taking `split(",")[0]` therefore reads a value the
 * caller picked:
 *
 *   - a rate limiter keyed on it hands out a fresh allowance per forged value,
 *     which makes the limit decorative and grows the limiter's map without
 *     bound;
 *   - an audit row written from it records an address the client invented, in
 *     the one table whose purpose is being trustworthy later.
 *
 * So we count hops from the RIGHT instead, and the count is CONFIGURATION about
 * the deployment rather than anything the request can influence:
 *
 *   client → Cloudflare → Railway edge → app          (cloud, 2 hops)
 *   client → nginx → app                              (on-premise, 1 hop)
 *   client → app                                      (dev, 0 hops)
 *
 * With N trusted proxies the client's address is the Nth entry from the right,
 * because each of those N proxies appended exactly one entry. Anything further
 * left is ignored — that is the whole fix.
 *
 * ⚠️ WHAT THIS DOES NOT COVER — the direct Railway host.
 * `*.up.railway.app` reaches the app without passing Cloudflare, so that path
 * has one hop rather than two, and a request there carrying its own
 * `X-Forwarded-For` shifts the window by one. The app cannot tell the two paths
 * apart: `Host` routes the request and so is equally client-supplied, and
 * `CF-Connecting-IP` is only meaningful when the origin refuses non-Cloudflare
 * traffic. Distinguishing them is an INFRASTRUCTURE control (lock the origin to
 * Cloudflare, e.g. a Transform Rule adding a shared secret header that the
 * origin requires), not something a header parser can decide. Until that is
 * done, the direct host bypasses this control exactly as it already bypasses
 * every Cloudflare protection in front of the app. See the PR for the ask.
 *
 * Deliberately NOT done here: `app.set("trust proxy", …)`. It would make
 * `req.ip` correct too, but it also changes `req.protocol`, `req.secure` and
 * `req.hostname` process-wide — which decide cookie `secure` flags and the SSO
 * redirect URI. Those deserve their own change with their own verification.
 */
import { isIP } from "node:net";
import { ENV } from "./env";

/** The shape we need — an Express request, or a tRPC ctx's `req`, or a test stub. */
export interface ProxiedRequest {
  headers?: Record<string, string | string[] | undefined> | undefined;
  socket?: { remoteAddress?: string | null } | null | undefined;
}

/** client → Cloudflare → Railway edge → app. */
export const CLOUD_TRUSTED_PROXY_HOPS = 2;
/** client → nginx → app (deploy/on-prem/nginx/*.conf sets X-Forwarded-For). */
export const ON_PREMISE_TRUSTED_PROXY_HOPS = 1;
/** A typo like `TRUSTED_PROXY_HOPS=200` must not silently mean "trust everything". */
export const MAX_TRUSTED_PROXY_HOPS = 10;

/**
 * Normalise one address, or reject it.
 *
 * Rejecting matters as much as normalising: an entry that is not an IP is an
 * entry a client made up, and letting it through would put arbitrary caller
 * text into limiter keys and the audit trail's `ipAddress` column.
 */
export function normalizeIp(value: string | null | undefined): string | null {
  let s = (value ?? "").trim();
  if (!s) return null;

  // "[::1]:443" — bracketed IPv6 with a port.
  const bracketed = /^\[(.+)\](?::\d+)?$/.exec(s);
  if (bracketed) {
    s = bracketed[1];
  } else if (s.includes(".") && s.includes(":")) {
    // "1.2.3.4:5678" — IPv4 with a port. A bare IPv6 has no dot, and an
    // IPv4-mapped IPv6 ("::ffff:1.2.3.4") has more than one colon.
    const parts = s.split(":");
    if (parts.length === 2) s = parts[0];
  }

  // "::ffff:1.2.3.4" → "1.2.3.4", so one client is one limiter key however the
  // proxy happened to spell it.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(s);
  if (mapped && isIP(mapped[1]) === 4) return mapped[1];

  return isIP(s) === 0 ? null : s.toLowerCase();
}

/**
 * How many proxies sit between the client and this process.
 *
 * `TRUSTED_PROXY_HOPS` overrides; otherwise the default follows the deployment
 * this build is running as. 0 means "ignore X-Forwarded-For entirely and use
 * the socket" — the right answer when nothing is in front of the app.
 */
export function resolveTrustedProxyHops(
  raw: string | undefined,
  deployment: { isProduction: boolean; deploymentMode: string },
): number {
  const configured = (raw ?? "").trim();
  if (configured !== "") {
    // Whole string or nothing: Number.parseInt("2.5.1") is 2, and silently
    // accepting half a value is how a topology change ends up half-applied.
    const n = /^\d+$/.test(configured) ? Number.parseInt(configured, 10) : Number.NaN;
    if (Number.isFinite(n) && n >= 0 && n <= MAX_TRUSTED_PROXY_HOPS) return n;
    console.warn(
      `[clientIp] TRUSTED_PROXY_HOPS=${configured} is not an integer in 0..${MAX_TRUSTED_PROXY_HOPS}; using the default for this deployment`,
    );
  }
  // Development runs with nothing in front of it; trusting a hop there would
  // mean trusting whatever a local caller sends.
  if (!deployment.isProduction) return 0;
  return deployment.deploymentMode === "on_premise"
    ? ON_PREMISE_TRUSTED_PROXY_HOPS
    : CLOUD_TRUSTED_PROXY_HOPS;
}

/** The effective hop count for this process. */
export const TRUSTED_PROXY_HOPS = resolveTrustedProxyHops(process.env.TRUSTED_PROXY_HOPS, {
  isProduction: ENV.isProduction,
  deploymentMode: ENV.deploymentMode,
});

/** One line at boot, so the next person can answer "what does it think it's behind?". */
export function describeTrustedProxyConfig(): string {
  return `[clientIp] trusted proxy hops = ${TRUSTED_PROXY_HOPS} (mode=${ENV.deploymentMode}, production=${ENV.isProduction})`;
}

function forwardedEntries(req: ProxiedRequest): string[] {
  const raw = req.headers?.["x-forwarded-for"];
  const header = Array.isArray(raw) ? raw.join(",") : raw;
  if (!header) return [];
  return header
    .split(",")
    .map(normalizeIp)
    .filter((ip): ip is string => ip !== null);
}

/**
 * The client's address, counting `trustedProxyHops` entries in from the right.
 *
 * Returns null only when nothing is knowable (no socket, no usable header).
 *
 * Note the clamp: a chain SHORTER than the configured topology means the
 * request crossed fewer proxies than expected, and the leftmost entry we have
 * is then the earliest address trusted infrastructure recorded. Reading past
 * the left edge would fall back to the proxy's own address and collapse every
 * caller into one bucket, which is the opposite failure.
 */
export function clientIpFrom(req: ProxiedRequest, trustedProxyHops: number): string | null {
  const socketIp = normalizeIp(req.socket?.remoteAddress);
  if (trustedProxyHops <= 0) return socketIp;

  const entries = forwardedEntries(req);
  if (entries.length === 0) return socketIp;

  return entries[Math.max(0, entries.length - trustedProxyHops)] ?? socketIp;
}

/** The client's address under this deployment's trusted-proxy policy. */
export function clientIp(req: ProxiedRequest | null | undefined): string | null {
  return req ? clientIpFrom(req, TRUSTED_PROXY_HOPS) : null;
}

/** For the call sites that want a string in hand (limiter keys, audit rows). */
export function clientIpOrUnknown(req: ProxiedRequest | null | undefined): string {
  return clientIp(req) ?? "unknown";
}
