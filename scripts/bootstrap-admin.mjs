#!/usr/bin/env node
// One-time super-admin bootstrap for air-gapped / on-premise deployments.
//
// A fresh on-prem box has an empty database, and magic-link auth depends on
// outbound email — which DEPLOYMENT_MODE=on_premise blocks by design. This
// script mints the first super-admin and prints a single-use sign-in link to
// stdout so the first login needs neither internet nor email.
//
// Idempotent: if a user with --email already exists it is (re)promoted to
// super_admin and a fresh link is minted. Raw SQL against the three stable
// auth tables (organizations, users, magic_link_tokens) via mysql2 — no app
// imports, so it runs in the slim runtime image with only DATABASE_URL set.
//
// Usage (inside the on-prem app container):
//   docker compose -f docker-compose.cpu.yml exec app \
//     node scripts/bootstrap-admin.mjs --email you@bank.com --name "Ada Admin" \
//     --org "Client Bank" --app-url https://reconcile.bank.internal
import crypto from "node:crypto";
import mysql from "mysql2/promise";

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const email = arg("--email");
const name = arg("--name", "Administrator");
const orgName = arg("--org", "Platform Operator");
const appUrl = arg("--app-url", process.env.APP_URL || "http://localhost:3000").replace(/\/+$/, "");
const TTL_HOURS = 72; // matches TOKEN_TTL_HOURS in server/magicLinkService.ts

if (!email) {
  console.error("ERROR: --email is required");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("ERROR: DATABASE_URL is not set");
  process.exit(1);
}

const conn = await mysql.createConnection(process.env.DATABASE_URL);
try {
  // 1. Find or create the operator org (segment = super_admin).
  const [orgRows] = await conn.execute(
    "SELECT id FROM organizations WHERE segment = 'super_admin' ORDER BY id LIMIT 1",
  );
  let orgId;
  if (orgRows.length) {
    orgId = orgRows[0].id;
  } else {
    const code = "ops-" + crypto.randomBytes(4).toString("hex");
    const [res] = await conn.execute(
      "INSERT INTO organizations (name, code, country, baseCurrency, segment, onboardingChannel, ssoProvider, isActive) " +
        "VALUES (?, ?, 'NGA', 'NGN', 'super_admin', 'direct', 'none', 1)",
      [orgName, code],
    );
    orgId = res.insertId;
    console.log(`Created super-admin organization #${orgId} (${orgName}).`);
  }

  // 2. Find or create the super-admin user.
  const [userRows] = await conn.execute("SELECT id FROM users WHERE email = ? LIMIT 1", [email]);
  let userId;
  if (userRows.length) {
    userId = userRows[0].id;
    await conn.execute(
      "UPDATE users SET role='super_admin', isActive=1, isGuest=0, organizationId=? WHERE id=?",
      [orgId, userId],
    );
    console.log(`Reused user #${userId} <${email}> and ensured super_admin.`);
  } else {
    const openId = "local:" + crypto.randomBytes(16).toString("hex");
    const [res] = await conn.execute(
      "INSERT INTO users (openId, name, email, loginMethod, role, organizationId, isGuest, isActive) " +
        "VALUES (?, ?, ?, 'bootstrap', 'super_admin', ?, 0, 1)",
      [openId, name, email, orgId],
    );
    userId = res.insertId;
    console.log(`Created super-admin user #${userId} <${email}>.`);
  }

  // 3. Mint a single-use magic-link token (stored as UTC, consumed by GET /api/magic-login).
  const token = crypto.randomBytes(48).toString("hex");
  const expiresAt = new Date(Date.now() + TTL_HOURS * 3600 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
  await conn.execute(
    "INSERT INTO magic_link_tokens (userId, token, expiresAt) VALUES (?, ?, ?)",
    [userId, token, expiresAt],
  );

  console.log("\n──────────────────────────────────────────────────────────────");
  console.log("  Sign-in link (single-use, valid 72h) — open it in a browser:");
  console.log(`  ${appUrl}/magic-login?token=${token}`);
  console.log("──────────────────────────────────────────────────────────────\n");
} finally {
  await conn.end();
}
