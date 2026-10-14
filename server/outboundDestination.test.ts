/**
 * The outbound destination guard: where the server will send a request a
 * tenant asked for.
 *
 * Greptile #196: once webhooks fired, an admin at any tenant could register
 * `http://127.0.0.1:<port>/`, a private address or the cloud metadata endpoint,
 * and the delivery worker would POST to it from inside the platform's network.
 *
 * The transport tests use real sockets against a local server, because the
 * claims worth pinning are about connections: a refused destination makes
 * none, an accepted one connects to the address that was checked (not to a
 * fresh lookup), and a redirect is not followed.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const egress = vi.hoisted(() => ({ onPremise: false, allowed: true }));
vi.mock("./_core/egress", () => ({
  isOnPremise: () => egress.onPremise,
  isEgressAllowed: () => egress.allowed,
}));

import {
  DestinationRefusedError,
  type DestinationPolicy,
  type Resolver,
  destinationPolicy,
  destinationProblem,
  permittedAddresses,
  postToDestination,
  publicAddressProblem,
  registrationProblem,
} from "./outboundDestination";

const answers = (...addresses: string[]): Resolver => async () =>
  addresses.map((address) => ({ address, family: address.includes(":") ? (6 as const) : (4 as const) }));

afterEach(() => {
  egress.onPremise = false;
  egress.allowed = true;
  vi.useRealTimers();
});

describe("which addresses are public internet hosts", () => {
  it.each([
    // [address, why it is refused]
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback"],
    ["10.0.0.1", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["192.168.1.1", "private"],
    ["100.64.0.1", "carrier-grade NAT"],
    ["169.254.169.254", "cloud metadata (link-local)"],
    ["0.0.0.0", "unspecified"],
    ["255.255.255.255", "broadcast"],
    ["224.0.0.1", "multicast"],
    ["192.0.2.10", "documentation"],
    ["198.18.0.1", "benchmarking"],
    ["::1", "IPv6 loopback"],
    ["::", "IPv6 unspecified"],
    ["fe80::1", "IPv6 link-local"],
    ["fc00::1", "IPv6 unique local"],
    ["fd12:3456::1", "IPv6 unique local (Railway private networking)"],
    ["fd00:ec2::254", "AWS metadata over IPv6"],
    ["::ffff:127.0.0.1", "IPv4-mapped loopback"],
    ["::ffff:169.254.169.254", "IPv4-mapped metadata"],
    ["64:ff9b::a9fe:a9fe", "NAT64 of the metadata address"],
    ["2002:7f00:1::1", "6to4 of loopback"],
    ["2001::1", "Teredo"],
    ["2001:db8::1", "IPv6 documentation"],
    ["ff02::1", "IPv6 multicast"],
  ])("should refuse %s (%s)", (address) => {
    expect(publicAddressProblem(address)).not.toBeNull();
  });

  it.each(["8.8.8.8", "1.1.1.1", "52.94.236.248", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "2a00:1450:4009:81f::200e"])(
    "should accept %s",
    (address) => {
      expect(publicAddressProblem(address)).toBeNull();
    },
  );
});

describe("when the deployment is cloud", () => {
  const policy = () => destinationPolicy();

  it.each([
    ["http://hooks.example.com/x", /only https/],
    ["https://user:pass@hooks.example.com/x", /credentials/],
    ["https://localhost/x", /internal host name/],
    ["https://LOCALHOST./x", /internal host name/],
    ["https://api.localhost/x", /internal host name/],
    ["https://redis.railway.internal/x", /internal host name/],
    ["https://printer.local/x", /internal host name/],
    ["https://metadata/x", /fully qualified/],
    ["https://127.0.0.1/x", /private or internal/],
    // WHATWG URL normalises these to 127.0.0.1 before the guard sees them.
    ["https://2130706433/x", /private or internal/],
    ["https://0x7f.1/x", /private or internal/],
    ["https://127.1/x", /private or internal/],
    ["https://[::1]/x", /not a public IPv6/],
    ["https://[::ffff:127.0.0.1]/x", /IPv4 address inside IPv6/],
    ["https://169.254.169.254/latest/meta-data/", /reserved or link-local/],
    ["https://hooks.example.com:0/x", /port/],
    ["not a url", /not valid/],
  ])("should refuse %s", (url, reason) => {
    expect(destinationProblem(url, policy())).toMatch(reason);
  });

  it.each(["https://hooks.example.com/services/T0/B0/x?token=1", "https://hooks.example.com:8443/x", "https://8.8.8.8/x", "https://[2606:4700:4700::1111]/x"])(
    "should accept %s before any lookup",
    (url) => {
      expect(destinationProblem(url, policy())).toBeNull();
    },
  );

  it("should name the host in a refusal, never the URL's path or query", () => {
    const problem = destinationProblem("https://127.0.0.1/services/T0/B0/very-secret-token", policy());
    expect(problem).toContain("127.0.0.1");
    expect(problem).not.toContain("very-secret-token");
  });
});

describe("when the deployment is on premise", () => {
  it("should allow the bank's own network, over http too", () => {
    egress.onPremise = true;
    expect(destinationProblem("http://10.1.2.3:8080/hook", destinationPolicy())).toBeNull();
    expect(destinationProblem("http://core-banking.bank.lan/hook", destinationPolicy())).toBeNull();
  });

  it("should still refuse metadata, link-local and IPv4 smuggled into IPv6", () => {
    egress.onPremise = true;
    expect(destinationProblem("http://169.254.169.254/latest/meta-data/", destinationPolicy())).toMatch(/link-local/);
    expect(destinationProblem("http://[fe80::1]/x", destinationPolicy())).toMatch(/link-local/);
    expect(destinationProblem("http://[::ffff:10.0.0.1]/x", destinationPolicy())).toMatch(/IPv4 address inside IPv6/);
  });

  it("should refuse a host the egress allow-list does not approve", () => {
    egress.onPremise = true;
    egress.allowed = false;
    expect(destinationProblem("https://hooks.example.com/x", destinationPolicy())).toMatch(/EGRESS_ALLOWLIST/);
  });
});

describe("when a host name resolves", () => {
  it("should refuse it if ANY answer is not public: a mixed answer is the attack", async () => {
    await expect(permittedAddresses("hooks.example.com", destinationPolicy(), answers("8.8.8.8", "10.0.0.5"))).rejects.toThrow(
      /hooks\.example\.com resolves to a refused address: 10\.0\.0\.5/,
    );
  });

  it("should refuse a name with no answers", async () => {
    await expect(permittedAddresses("hooks.example.com", destinationPolicy(), answers())).rejects.toThrow(/does not resolve/);
  });

  it("should accept a name whose every answer is public", async () => {
    await expect(permittedAddresses("hooks.example.com", destinationPolicy(), answers("8.8.8.8", "2606:4700:4700::1111"))).resolves.toHaveLength(2);
  });
});

describe("when an admin registers a URL", () => {
  it("should refuse one whose name resolves inside a network, saying why", async () => {
    await expect(registrationProblem("https://rebind.example.com/x", destinationPolicy(), answers("127.0.0.1"))).resolves.toMatch(
      /rebind\.example\.com resolves to a refused address: 127\.0\.0\.1/,
    );
  });

  it("should refuse one that does not resolve", async () => {
    const missing: Resolver = async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    };
    await expect(registrationProblem("https://typo.example.com/x", destinationPolicy(), missing)).resolves.toMatch(/could not be resolved/);
  });

  it("should give up on a lookup that hangs, rather than hold the request", async () => {
    vi.useFakeTimers();
    const pending = registrationProblem("https://slow.example.com/x", destinationPolicy(), () => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(3_001);
    await expect(pending).resolves.toMatch(/could not be resolved/);
  });

  it("should accept one that resolves to public addresses", async () => {
    await expect(registrationProblem("https://hooks.example.com/x", destinationPolicy(), answers("8.8.8.8"))).resolves.toBeNull();
  });
});

// ─── Real sockets ────────────────────────────────────────────────────────────

describe("when the transport meets a real server", () => {
  let server: http.Server;
  let port = 0;
  let connections = 0;
  const requests: Array<{ method?: string; url?: string; host?: string; body: string; headers: http.IncomingHttpHeaders }> = [];
  /** How the next request is answered. */
  let respond: (res: http.ServerResponse) => void = (res) => res.writeHead(200).end("ok");

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        requests.push({ method: req.method, url: req.url, host: req.headers.host, body, headers: req.headers });
        respond(res);
      });
    });
    server.on("connection", () => connections++);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterEach(() => {
    requests.length = 0;
    connections = 0;
    respond = (res) => res.writeHead(200).end("ok");
  });

  /** A policy that lets this test reach its own loopback server, and nothing else. */
  const loopbackOnly: DestinationPolicy = {
    name: "test-loopback",
    urlProblem: (url) => (url.protocol === "http:" ? null : "test policy: http only"),
    addressProblem: (address) => (address === "127.0.0.1" ? null : `test policy: ${address} refused`),
  };
  const post = { headers: { "Content-Type": "application/json", "X-Test": "1" }, body: '{"event":"x"}', timeoutMs: 2_000 };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

  it("should refuse an IP-literal loopback destination without connecting", async () => {
    await expect(postToDestination(`https://127.0.0.1:${port}/hook`, post, destinationPolicy())).rejects.toBeInstanceOf(
      DestinationRefusedError,
    );
    await settle();
    expect(connections).toBe(0);
  });

  it("should refuse a public-looking name that resolves to loopback, at the socket, without connecting", async () => {
    // DNS rebinding: the name passes every check made before the lookup.
    await expect(
      postToDestination(`https://rebind.example.com:${port}/hook`, post, destinationPolicy(), answers("127.0.0.1")),
    ).rejects.toBeInstanceOf(DestinationRefusedError);
    await settle();
    expect(connections).toBe(0);
  });

  it("should connect to the checked address, keeping the name as the Host", async () => {
    // `receiver.test` does not exist in DNS, so reaching the server proves the
    // socket used the guard's own answer rather than a second lookup.
    const result = await postToDestination(`http://receiver.test:${port}/hook?x=1`, post, loopbackOnly, answers("127.0.0.1"));

    expect(result).toEqual({ status: 200 });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: "POST", url: "/hook?x=1", host: `receiver.test:${port}`, body: '{"event":"x"}' });
    expect(requests[0].headers["x-test"]).toBe("1");
    expect(requests[0].headers["content-length"]).toBe(String(Buffer.byteLength(post.body)));
  });

  it("should refuse at the socket when the answer is not one the policy permits", async () => {
    await expect(
      postToDestination(`http://receiver.test:${port}/hook`, post, loopbackOnly, answers("127.0.0.2")),
    ).rejects.toThrow(/test policy: 127\.0\.0\.2 refused/);
    await settle();
    expect(connections).toBe(0);
  });

  it("should report a redirect without following it", async () => {
    respond = (res) => res.writeHead(302, { Location: `http://receiver.test:${port}/elsewhere` }).end();
    const result = await postToDestination(`http://receiver.test:${port}/hook`, post, loopbackOnly, answers("127.0.0.1"));

    expect(result).toEqual({ status: 302 });
    await settle();
    expect(requests.map((r) => r.url)).toEqual(["/hook"]);
  });

  it("should give up on a receiver that never answers", async () => {
    respond = () => {}; // hold the request open
    const started = Date.now();
    await expect(
      postToDestination(`http://receiver.test:${port}/hook`, { ...post, timeoutMs: 300 }, loopbackOnly, answers("127.0.0.1")),
    ).rejects.toMatchObject({ code: "ETIMEDOUT" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
