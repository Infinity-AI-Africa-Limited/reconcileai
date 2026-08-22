import { describe, expect, it } from "vitest";
import fs from "node:fs";

const env = fs.readFileSync("server/_core/env.ts", "utf8");
const index = fs.readFileSync("server/_core/index.ts", "utf8");
const sso = fs.readFileSync("server/_core/sso.ts", "utf8");

describe("bank session policy", () => {
  it("defaults to an eight-hour application session and bounds overrides", () => {
    expect(env).toContain('raw ?? "480"');
    expect(env).toContain("Math.min(Math.max(minutes, 15), 1_440)");
    expect(env).toContain("sessionTtlMs: boundedSessionTtlMs(process.env.SESSION_TTL_MINUTES)");
  });

  it("uses the shared bounded session TTL for magic-link and enterprise SSO sessions", () => {
    expect(index).toContain("expiresInMs: ENV.sessionTtlMs");
    expect(index).toContain("maxAge: ENV.sessionTtlMs");
    expect(sso).toContain("expiresInMs: ENV.sessionTtlMs");
    expect(sso).toContain("maxAge: ENV.sessionTtlMs");
    expect(index).not.toContain("expiresInMs: ONE_YEAR_MS");
    expect(sso).not.toContain("expiresInMs: ONE_YEAR_MS");
  });
});
