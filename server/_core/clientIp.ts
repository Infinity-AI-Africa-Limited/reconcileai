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
 * ⚠️ ONE DEPLOYMENT, TWO PATHS — the direct Railway host.
 * `*.up.railway.app` reaches the app without passing Cloudflare, so it crosses
 * one hop fewer, and applying the cloud count there reads one entry into
 * caller-controlled space. Nothing IN the request settles which path it took:
 * `Host` is what routes it, so a caller can send either, and `CF-Connecting-IP`
 * only means something once the origin is restricted to Cloudflare.
 *
 * So the edge has to say so itself. `CLOUDFLARE_ORIGIN_SECRET` + a Cloudflare
 * Transform Rule injecting `x-origin-verify` make the path provable: a verified
 * request gets the configured count, an unverified one is treated as having
 * crossed one hop fewer (see `effectiveHopsFor`). Unset, the check is inert and
 * the direct host remains a bypass — of this control and of every other
 * Cloudflare protection in front of the app.
 *
 * Deliberately NOT done here: `app.set("trust proxy", …)`. It would make
 * `req.ip` correct too, but it also changes `req.protocol`, `req.secure` and
 * `req.hostname` process-wide — which decide cookie `secure` flags and the SSO
 * redirect URI. Those deserve their own change with their own verification.
 */
import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { ENV } from "./env";

/** The shape we need — an Express request, or a tRPC ctx's `req`, or a test stub. */
export interface ProxiedRequest {
  headers?: Record<string, string | string[] | undefined> | undefined;
  socket?: { remoteAddress?: string | null; encrypted?: boolean } | null | undefined;
  /** Express's own view of the scheme, which without `trust proxy` is the raw connection. */
  protocol?: string | undefined;
  secure?: boolean | undefined;
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
  const edge = ENV.cloudflareOriginSecret
    ? "edge-verified requests only"
    : "no edge secret — the direct origin hostname is not distinguishable";
  return `[clientIp] trusted proxy hops = ${TRUSTED_PROXY_HOPS} (mode=${ENV.deploymentMode}, production=${ENV.isProduction}; ${edge})`;
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

/**
 * Header Cloudflare adds (Transform Rule) to prove a request crossed the edge.
 * Nothing else can set it: the rule overwrites any caller-supplied value, and a
 * caller reaching the origin directly does not know the secret.
 */
export const ORIGIN_VERIFY_HEADER = "x-origin-verify";

/**
 * Did this request provably cross the edge proxy?
 *
 * `null` = the question is not configured, so no request can answer it.
 */
function crossedVerifiedEdge(req: ProxiedRequest, secret: string): boolean | null {
  if (!secret) return null;
  const raw = req.headers?.[ORIGIN_VERIFY_HEADER];
  const presented = Array.isArray(raw) ? raw[0] : raw;
  if (typeof presented !== "string" || presented.length === 0) return false;

  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  // timingSafeEqual throws on a length mismatch, and the length itself is not
  // worth leaking, so compare it separately and never short-circuit.
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * How long a proof that the edge is really injecting the header stays good for.
 *
 * Production traffic renews this continuously, so the window only matters at
 * the two edges of a rollout — see `effectiveHopsFor`.
 */
export const EDGE_PROOF_TTL_MS = 10 * 60_000;

/** When this process last saw a request the edge had vouched for. */
let lastEdgeProofAt = 0;

/** Tests and ops: forget what this process has observed. */
export function resetEdgeProof(): void {
  lastEdgeProofAt = 0;
}

/** Whether the edge has proven itself recently enough to reason from. */
export function edgeProofIsFresh(now: number = Date.now()): boolean {
  return lastEdgeProofAt > 0 && now - lastEdgeProofAt <= EDGE_PROOF_TTL_MS;
}

/**
 * How many hops THIS request crossed.
 *
 * The count is per-deployment, but one deployment can be reached two ways: the
 * direct `*.up.railway.app` hostname skips Cloudflare, so it crosses one hop
 * fewer, and applying the cloud count there reads one entry into
 * caller-controlled space. `Host` cannot tell the two apart — it is what routes
 * the request, so a caller can send either — but a secret the edge injects can.
 *
 * An unverified request is treated as having crossed one hop fewer. It is never
 * REJECTED — an origin lock that can take the site down on a misconfigured rule
 * is the worse trade — it just stops being able to shift the window.
 *
 * ⚠️ BUT "no header" has two very different causes, and only one of them is a
 * direct request. The other is that the Transform Rule is not live yet: the
 * secret and the rule are separate manual steps, so between them EVERY request
 * arrives unverified. Dropping a hop for all of them would select the edge's own
 * egress address — unrelated people sharing one login rate-limit bucket, and
 * that address in every audit row. A rollout step must not be able to cause
 * that, so the header's ABSENCE is never evidence on its own.
 *
 * So the rule is evidence-led, not configuration-led (the same shape as email
 * inbound's unconfigured → unproven → receiving): a hop is dropped only once
 * this process has RECENTLY seen a request the edge did vouch for. Before that
 * first proof — and again if proofs stop arriving, i.e. the rule was removed —
 * every request uses the configured count, which is exactly the behaviour
 * before this check existed. Configuration is never evidence of capability.
 */
export function effectiveHopsFor(
  req: ProxiedRequest,
  configuredHops: number,
  originSecret: string,
  now: number = Date.now(),
): number {
  const verified = crossedVerifiedEdge(req, originSecret);
  if (verified === null) return configuredHops; // not configured — inert
  if (verified) {
    if (lastEdgeProofAt === 0) {
      console.log("[clientIp] edge verification header observed; unverified requests now count one hop fewer");
    }
    lastEdgeProofAt = now;
    return configuredHops;
  }
  // Unverified, and nothing recent says the edge is stamping requests at all.
  // Treat that as "we cannot tell", not as "this came the short way".
  if (!edgeProofIsFresh(now)) return configuredHops;
  return Math.max(0, configuredHops - 1);
}

/** The client's address under this deployment's trusted-proxy policy. */
export function clientIp(req: ProxiedRequest | null | undefined): string | null {
  return req ? clientIpFrom(req, effectiveHopsFor(req, TRUSTED_PROXY_HOPS, ENV.cloudflareOriginSecret)) : null;
}

/** For the call sites that want a string in hand (limiter keys, audit rows). */
export function clientIpOrUnknown(req: ProxiedRequest | null | undefined): string {
  return clientIp(req) ?? "unknown";
}

/** The scheme of the connection this process actually accepted. */
/**
 * Log the first X-Forwarded-Proto shape this process sees, once.
 *
 * The append-vs-overwrite question above is answered by what the edge actually
 * sends, and that is not documented anywhere we control. One line at the first
 * real request makes it a log lookup instead of an assumption.
 */
let loggedProtoShape = false;
function noteForwardedProtoShape(header: string, entryCount: number): void {
  if (loggedProtoShape) return;
  loggedProtoShape = true;
  console.log(`[clientIp] first x-forwarded-proto seen: "${header}" (${entryCount} entr${entryCount === 1 ? "y" : "ies"})`);
}

function rawSchemeIsSecure(req: ProxiedRequest): boolean {
  if (req.secure === true) return true;
  if (req.socket?.encrypted === true) return true;
  return (req.protocol ?? "").toLowerCase() === "https";
}

/**
 * Was the request HTTPS end to end?
 *
 * Behind a TLS-terminating proxy the socket is plaintext, so `req.protocol` says
 * `http` and anything derived from it is wrong. That is why the SSO flow cookie
 * (PKCE verifier, state, nonce) shipped WITHOUT the Secure attribute.
 *
 * ⚠️ This header is NOT read the same way as `X-Forwarded-For`, on purpose.
 * XFF is append-only by specification, so the client's address sits at a known
 * index. `X-Forwarded-Proto` has no such guarantee — some proxies append, some
 * OVERWRITE — so indexing into it would be asserting a shape nobody documents,
 * and getting it wrong drops `Secure` from an auth cookie.
 *
 * So instead: look only at the RIGHTMOST `trustedProxyHops` entries — the ones
 * trusted infrastructure can have written — and say https if ANY of them does.
 * That is correct whether the proxies append or overwrite, and whether the chain
 * is shorter than the window:
 *
 *   "https,https"        → https ✔        (both proxies appended)
 *   "https"              → https ✔        (a proxy overwrote)
 *   "http,https,https"   → https ✔        (caller's entry is outside the window)
 *   "http,https"         → https ✔        (one appended, one overwrote)
 *   "https,http,http"    → http  ✔        (a caller cannot claim https)
 *   "http,http"          → http  ✔        (genuinely plaintext)
 *
 * The asymmetry is deliberate: a wrong `false` drops Secure from a live auth
 * cookie, while a wrong `true` only makes the browser discard a cookie the
 * caller themselves mislabelled. Only one of those is someone else's problem.
 */
export function requestIsSecureFrom(req: ProxiedRequest, trustedProxyHops: number): boolean {
  if (trustedProxyHops <= 0) return rawSchemeIsSecure(req);

  const raw = req.headers?.["x-forwarded-proto"];
  const header = Array.isArray(raw) ? raw.join(",") : raw;
  const entries = (header ?? "")
    .split(",")
    .map(s => s.trim().toLowerCase())
    .filter(s => s === "http" || s === "https");
  if (entries.length === 0) return rawSchemeIsSecure(req);

  noteForwardedProtoShape(header ?? "", entries.length);
  return entries.slice(-trustedProxyHops).includes("https");
}

/** Was the request HTTPS end to end, under this deployment's proxy policy? */
export function requestIsSecure(req: ProxiedRequest | null | undefined): boolean {
  if (!req) return false;
  return requestIsSecureFrom(req, effectiveHopsFor(req, TRUSTED_PROXY_HOPS, ENV.cloudflareOriginSecret));
}

/** `https` or `http`, for building a URL back to this deployment. */
export function requestScheme(req: ProxiedRequest | null | undefined): "https" | "http" {
  return requestIsSecure(req) ? "https" : "http";
}

/**
 * This deployment's own origin, for building a URL that points back at it —
 * an OAuth redirect_uri, a post-install redirect, a reviewer link.
 *
 * `APP_URL` first, because it is the only value that is not derived from the
 * request. The fallback uses `Host` (what actually routed the request) and
 * NEVER `X-Forwarded-Host`: that header is caller-supplied, and a redirect
 * built from it sends the visitor wherever the caller asked — while a
 * redirect_uri built from it stops matching what the provider has registered.
 *
 * The scheme comes from the hop policy above, so a proxied deployment does not
 * advertise `http://` URLs for an https site.
 */
export function appOriginFor(req: ProxiedRequest | null | undefined): string {
  const configured = (ENV.appUrl ?? "").trim().replace(/\/+$/, "");
  if (configured) return configured;

  const rawHost = req?.headers?.host;
  const host = (Array.isArray(rawHost) ? rawHost[0] : rawHost)?.trim();
  return host ? `${requestScheme(req)}://${host}` : "";
}
