/**
 * Where the platform may send a request on a tenant's behalf.
 *
 * A tenant names the URL; the server makes the request. Without a guard, an
 * admin at any tenant could register `http://127.0.0.1:6379/`, a private
 * address, or the cloud metadata endpoint (169.254.169.254), and have the
 * server POST to services the tenant cannot reach itself (Greptile #196). The
 * guard has three parts, because each closes a bypass the others leave open:
 *
 *   1. The URL, before anything is resolved: scheme, no credentials in it, no
 *      internal-looking host, and an IP-literal host checked as an address.
 *      WHATWG URL parsing has already normalised `2130706433`, `0x7f.1` and
 *      `127.1` to `127.0.0.1`, so those disguises meet the address check.
 *   2. Every address the host resolves to. One bad answer refuses the request:
 *      the tenant controls the DNS, so a mix of public and private answers is
 *      the attack, not an accident.
 *   3. The connection goes to the addresses that were checked. The check runs
 *      as the socket's own `lookup`, so nothing re-resolves the name between
 *      check and connect (DNS rebinding), and redirects are never followed,
 *      since a redirect to an internal URL would skip both checks.
 *
 * The address rule is an allow-list wherever the address space allows one:
 * in cloud mode an IPv6 destination must be global unicast (2000::/3), and
 * IPv4 must fall outside every special-purpose range (IANA registry).
 *
 * The rule depends on the deployment:
 *   - cloud: https only, public addresses only;
 *   - on_premise: http or https, the bank's own private network is the point,
 *     and the existing egress guard (EGRESS_ALLOWLIST) decides which outside
 *     hosts are approved.
 * In both, addresses that are never a legitimate destination are refused:
 * unspecified, link-local (the metadata endpoints live there), multicast,
 * reserved, and IPv4 smuggled inside IPv6 (mapped, NAT64).
 *
 * Messages name the host or address, never the URL: a webhook URL's path or
 * query often carries a token (`hooks.example/services/T0/B0/xyz`).
 */
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { isEgressAllowed, isOnPremise } from "./_core/egress";

/** A destination the platform will not send to. Final: retrying cannot help. */
export class DestinationRefusedError extends Error {
  readonly code = "DESTINATION_REFUSED";
  constructor(readonly reason: string) {
    super(`Destination refused: ${reason}`);
    this.name = "DestinationRefusedError";
  }
}

export interface DestinationPolicy {
  /** Shown in logs and tests only. */
  readonly name: string;
  /** Why this URL may not be used, judged before any lookup; null when it may. */
  urlProblem(url: URL): string | null;
  /** Why this address may not be connected to; null when it may. */
  addressProblem(address: string): string | null;
}

// ─── Address sets ─────────────────────────────────────────────────────────────

type Subnet = readonly [address: string, prefix: number];

function subnets(family: "ipv4" | "ipv6", entries: readonly Subnet[]): net.BlockList {
  const list = new net.BlockList();
  for (const [address, prefix] of entries) list.addSubnet(address, prefix, family);
  return list;
}

/**
 * Never a destination, in any deployment. Nothing we deliver to listens on
 * these, and the cloud metadata services do (169.254.169.254, fd00:ec2::254).
 */
const NEVER_V4 = subnets("ipv4", [
  ["0.0.0.0", 8], // "this network"
  ["169.254.0.0", 16], // link-local, incl. cloud metadata
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, incl. 255.255.255.255
]);
const NEVER_V6 = subnets("ipv6", [
  ["::", 128], // unspecified
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
  ["fd00:ec2::254", 128], // AWS instance metadata over IPv6
  ["64:ff9b::", 96], // NAT64: an IPv4 address in disguise
  ["64:ff9b:1::", 48], // local-use NAT64
]);
/**
 * IPv4-mapped IPv6 (::ffff:a.b.c.d). Kept in a list of its own: net.BlockList
 * matches IPv4 and mapped IPv6 against each other in both directions, so this
 * list is consulted for IPv6 addresses only.
 */
const MAPPED_V4 = subnets("ipv6", [["::ffff:0:0", 96]]);

/** IPv4 that is not on the public internet (IANA special-purpose registry). */
const NON_PUBLIC_V4 = subnets("ipv4", [
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["172.16.0.0", 12],
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
]);
/** The IPv6 allow-list: global unicast. Everything outside it is refused in cloud mode. */
const GLOBAL_UNICAST_V6 = subnets("ipv6", [["2000::", 3]]);
/** Inside 2000::/3, but not a host on the public internet. */
const NON_PUBLIC_IN_GLOBAL_V6 = subnets("ipv6", [
  ["2001::", 23], // IETF protocol assignments, incl. Teredo (2001::/32)
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4: an IPv4 address in disguise
  ["3fff::", 20], // documentation (RFC 9637)
]);

/** Why an address is never a destination, in any deployment; null otherwise. */
function neverProblem(address: string): string | null {
  const family = net.isIP(address);
  if (family === 4) return NEVER_V4.check(address, "ipv4") ? `${address} is a reserved or link-local address` : null;
  if (family === 6) {
    if (MAPPED_V4.check(address, "ipv6")) return `${address} is an IPv4 address inside IPv6; use the IPv4 address`;
    return NEVER_V6.check(address, "ipv6") ? `${address} is a reserved or link-local address` : null;
  }
  return `${address} is not an IP address`;
}

/** Why an address is not a public internet host; null when it is. */
export function publicAddressProblem(address: string): string | null {
  const never = neverProblem(address);
  if (never) return never;
  if (net.isIP(address) === 4) {
    return NON_PUBLIC_V4.check(address, "ipv4") ? `${address} is a private or internal address` : null;
  }
  const isGlobal =
    GLOBAL_UNICAST_V6.check(address, "ipv6") && !NON_PUBLIC_IN_GLOBAL_V6.check(address, "ipv6");
  return isGlobal ? null : `${address} is not a public IPv6 address`;
}

// ─── Hosts ───────────────────────────────────────────────────────────────────

/** URL.hostname, without IPv6 brackets or a trailing root dot, lower-cased. */
export function bareHost(hostname: string): string {
  const unbracketed = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return unbracketed.replace(/\.$/, "").toLowerCase();
}

/** Names that only resolve inside a network, never to a public host. */
const INTERNAL_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".intranet", ".home.arpa", ".localdomain"];

function internalHostnameProblem(host: string): string | null {
  if (host === "localhost" || INTERNAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return `${host} is an internal host name`;
  }
  // A single label resolves through the server's own search domains, to
  // whatever the platform's network calls that name.
  if (!host.includes(".")) return `${host} is not a fully qualified host name`;
  return null;
}

// ─── Policies ────────────────────────────────────────────────────────────────

const CLOUD_POLICY: DestinationPolicy = {
  name: "cloud",
  urlProblem(url) {
    if (url.protocol !== "https:") return "only https destinations are allowed";
    const host = bareHost(url.hostname);
    return net.isIP(host) ? null : internalHostnameProblem(host);
  },
  addressProblem: publicAddressProblem,
};

const ON_PREMISE_POLICY: DestinationPolicy = {
  name: "on_premise",
  urlProblem(url) {
    if (url.protocol !== "https:" && url.protocol !== "http:") return "only http and https destinations are allowed";
    if (!isEgressAllowed(url.href)) {
      return `${bareHost(url.hostname)} is not an approved destination on this deployment (EGRESS_ALLOWLIST)`;
    }
    return null;
  },
  addressProblem: neverProblem,
};

/** The rule for this deployment. */
export function destinationPolicy(): DestinationPolicy {
  return isOnPremise() ? ON_PREMISE_POLICY : CLOUD_POLICY;
}

/**
 * Why `raw` may not be used as a destination, judged without any lookup; null
 * when it may. An IP-literal host is judged here as an address, because a
 * connection to an IP literal never calls `lookup`.
 */
export function destinationProblem(raw: string, policy: DestinationPolicy): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "the URL is not valid";
  }
  if (url.username || url.password) return "the URL must not contain credentials";
  if (url.port === "0") return "the URL's port is not valid";
  const urlProblem = policy.urlProblem(url);
  if (urlProblem) return urlProblem;
  const host = bareHost(url.hostname);
  return net.isIP(host) ? policy.addressProblem(host) : null;
}

// ─── Resolution ──────────────────────────────────────────────────────────────

export type ResolvedAddress = { address: string; family: 4 | 6 };
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export const systemResolver: Resolver = async (hostname) => {
  const found = await dns.promises.lookup(hostname, { all: true });
  return found.map(({ address, family }) => ({ address, family: family === 6 ? 6 : 4 }));
};

/** The host's addresses, or a refusal if ANY of them is not allowed. */
export async function permittedAddresses(
  hostname: string,
  policy: DestinationPolicy,
  resolve: Resolver,
): Promise<ResolvedAddress[]> {
  const addresses = await resolve(hostname);
  if (addresses.length === 0) throw new DestinationRefusedError(`${hostname} does not resolve`);
  for (const { address } of addresses) {
    const problem = policy.addressProblem(address);
    if (problem) throw new DestinationRefusedError(`${hostname} resolves to a refused address: ${problem}`);
  }
  return addresses;
}

const REGISTRATION_LOOKUP_MS = 3_000;

/**
 * For registering a destination: the static checks, then a lookup, so an
 * admin hears now that a URL points inside a network rather than from a
 * delivery that fails later. Delivery repeats every check: DNS can change.
 */
export async function registrationProblem(
  raw: string,
  policy: DestinationPolicy,
  resolve: Resolver = systemResolver,
): Promise<string | null> {
  const problem = destinationProblem(raw, policy);
  if (problem) return problem;
  const host = bareHost(new URL(raw).hostname);
  if (net.isIP(host)) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      permittedAddresses(host, policy, resolve),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("lookup timed out")), REGISTRATION_LOOKUP_MS);
      }),
    ]);
    return null;
  } catch (err) {
    if (err instanceof DestinationRefusedError) return err.reason;
    return `${host} could not be resolved; check the address`;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Transport ───────────────────────────────────────────────────────────────

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number,
) => void;

/**
 * A socket `lookup` that resolves, checks every answer, and hands the socket
 * only checked addresses. Answers both call shapes: `all: true` (what Node
 * uses with autoSelectFamily, its default) and the single-address form.
 */
function checkedLookup(policy: DestinationPolicy, resolve: Resolver) {
  return (hostname: string, options: { all?: boolean; family?: number | string }, callback: LookupCallback) => {
    permittedAddresses(hostname, policy, resolve)
      .then((addresses) => {
        const wanted = options.family === 4 || options.family === 6 ? options.family : 0;
        const usable = wanted ? addresses.filter((a) => a.family === wanted) : addresses;
        if (usable.length === 0) {
          callback(Object.assign(new Error(`${hostname} has no IPv${wanted} address`), { code: "ENOTFOUND" }), "");
          return;
        }
        if (options.all) callback(null, usable);
        else callback(null, usable[0].address, usable[0].family);
      })
      .catch((err: NodeJS.ErrnoException) => callback(err, ""));
  };
}

export interface OutboundPost {
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}

/**
 * POST `body` to `raw`, under `policy`. Resolves with the response status —
 * any status, a redirect included: a redirect is never followed, and the
 * caller decides what a status means. Rejects with DestinationRefusedError
 * for a destination the policy refuses (before any connection is made, or at
 * the socket's own lookup), and with a network error otherwise.
 *
 * The response body is never read: a webhook receiver's answer is its status.
 */
export function postToDestination(
  raw: string,
  request: OutboundPost,
  policy: DestinationPolicy,
  resolve: Resolver = systemResolver,
): Promise<{ status: number }> {
  const problem = destinationProblem(raw, policy);
  if (problem) return Promise.reject(new DestinationRefusedError(problem));

  const url = new URL(raw);
  const host = bareHost(url.hostname);
  const transport = url.protocol === "https:" ? https : http;

  return new Promise((resolvePost, rejectPost) => {
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const settle = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      outcome();
    };

    const req = transport.request(
      {
        method: "POST",
        protocol: url.protocol,
        hostname: host,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        headers: { ...request.headers, "Content-Length": String(Buffer.byteLength(request.body)) },
        // A fresh socket per delivery: a pooled one may have been opened for
        // an earlier answer to the same name.
        agent: false,
        lookup: checkedLookup(policy, resolve) as unknown as net.LookupFunction,
        // TLS still verifies the certificate against the host NAME.
        ...(net.isIP(host) ? {} : { servername: host }),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        // The body is not wanted; close the connection rather than drain it.
        res.destroy();
        settle(() => resolvePost({ status }));
      },
    );

    // The whole exchange, not only socket idleness.
    deadline = setTimeout(
      () => req.destroy(Object.assign(new Error(`timed out after ${request.timeoutMs}ms`), { code: "ETIMEDOUT" })),
      request.timeoutMs,
    );

    req.on("error", (err) => settle(() => rejectPost(err)));
    req.end(request.body);
  });
}
