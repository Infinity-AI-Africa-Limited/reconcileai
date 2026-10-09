/**
 * shopify.app.toml, checked against what the code actually serves.
 *
 * The TOML is what Shopify is told, and the code is what answers. The file is
 * READ (every value in the section that holds it) and compared whole with a
 * configuration built from the runtime constants, so a misplaced setting, an
 * extra scope or section, or a path renamed in code each fail here. They are
 * not left to surface as a refused OAuth redirect or failing webhooks in
 * production.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SHOPIFY_API_VERSION, SHOPIFY_ORDER_LED_SCOPES } from "../../../drizzle/shopify_schema";
import { SHOPIFY_APP_HOME_PATH, SHOPIFY_OAUTH_CALLBACK_PATH, SHOPIFY_WEBHOOK_PATH } from "./paths";
import { SHOPIFY_ORDER_TRIGGER_TOPICS, SHOPIFY_PRIVACY_TOPICS, SHOPIFY_UNINSTALL_TOPIC } from "./webhooks";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
// Line endings normalised: a Windows checkout has CRLF, which TOML allows.
const config = fs.readFileSync(path.join(root, "shopify.app.toml"), "utf8").replace(/\r\n/g, "\n");

/** The production origin the deployed configuration names (APP_URL in production). */
const ORIGIN = "https://www.reconcileaiafrica.com";

// ─── A strict reader for the TOML this file uses ─────────────────────────────

type TomlValue = string | boolean | string[];
interface TomlTable {
  [key: string]: TomlValue | TomlTable | TomlTable[];
}

/**
 * Reads the slice of TOML this file uses, and refuses everything else:
 * - comments;
 * - `[table]` and `[[array.of.tables]]` headers;
 * - `key = "string" | true | false | ["string", …]`, where an array may span
 *   lines.
 *
 * An unsupported construct, a duplicate key or a redefined table THROWS, so
 * what the reader does not understand fails the test instead of being misread.
 * There is no TOML parser in the dependency tree, and this file needs very
 * little of the language.
 */
function readToml(source: string): TomlTable {
  const doc: TomlTable = {};
  let current = doc;
  const definedTables = new Set<string>();
  const lines = source.split(/\r?\n/);

  const fail = (line: number, why: string): never => {
    throw new Error(`shopify.app.toml line ${line + 1}: ${why}`);
  };
  const stripComment = (text: string, line: number) => {
    let quoted = false;
    for (let i = 0; i < text.length; i += 1) {
      if (text[i] === "\\") fail(line, "escape sequences are not supported");
      if (text[i] === '"') quoted = !quoted;
      else if (text[i] === "#" && !quoted) return text.slice(0, i);
    }
    return text;
  };
  const tableAt = (keys: string[], line: number): TomlTable => {
    let table = doc;
    for (const key of keys) {
      const next = table[key];
      if (next === undefined) table = table[key] = {};
      else if (Array.isArray(next) && typeof next[0] === "object") table = next[next.length - 1] as TomlTable;
      else if (typeof next === "object" && !Array.isArray(next)) table = next;
      else fail(line, `"${key}" is a value, not a table`);
    }
    return table;
  };
  const parseScalar = (text: string, line: number): string | boolean => {
    if (text === "true") return true;
    if (text === "false") return false;
    const quoted = /^"([^"]*)"$/.exec(text);
    if (!quoted) fail(line, `unsupported value: ${text}`);
    return quoted![1];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const text = stripComment(lines[i], i).trim();
    if (text === "") continue;

    const header = /^(\[\[?)\s*([A-Za-z0-9_.-]+)\s*(\]\]?)$/.exec(text);
    if (header) {
      const array = header[1] === "[[";
      if (array !== (header[3] === "]]")) fail(i, "mismatched header brackets");
      const keys = header[2].split(".");
      if (keys.some((key) => key === "")) fail(i, "empty key in header");
      if (array) {
        const parent = tableAt(keys.slice(0, -1), i);
        const last = keys[keys.length - 1];
        const existing = parent[last];
        if (existing !== undefined && !(Array.isArray(existing) && typeof existing[0] === "object")) {
          fail(i, `"${header[2]}" is already defined as something else`);
        }
        const tables = (existing as TomlTable[] | undefined) ?? (parent[last] = []);
        current = {};
        tables.push(current);
      } else {
        if (definedTables.has(header[2])) fail(i, `table [${header[2]}] defined twice`);
        definedTables.add(header[2]);
        current = tableAt(keys, i);
      }
      continue;
    }

    const assignment = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(text);
    if (!assignment) fail(i, `unsupported syntax: ${text}`);
    const [, key, rawValue] = assignment!;
    if (key in current) fail(i, `"${key}" defined twice`);

    if (rawValue.startsWith("[")) {
      // Gather the array, which may run over several lines.
      let body = rawValue;
      while (!body.includes("]")) {
        i += 1;
        if (i >= lines.length) fail(i - 1, `unterminated array "${key}"`);
        body += " " + stripComment(lines[i], i).trim();
      }
      const inner = /^\[(.*)\]$/.exec(body.trim());
      if (!inner) fail(i, `unsupported array: ${body}`);
      const items = inner![1].split(",").map((item) => item.trim()).filter((item) => item !== "");
      current[key] = items.map((item) => {
        const value = parseScalar(item, i);
        if (typeof value !== "string") fail(i, `"${key}" may hold strings only`);
        return value as string;
      });
    } else {
      current[key] = parseScalar(rawValue.trim(), i);
    }
  }
  return doc;
}

// ─── What the configuration must be ──────────────────────────────────────────

const sorted = (values: Iterable<string>) => [...values].sort();

/** The configuration the code serves, with topic lists order-independent. */
function expectedConfig(): TomlTable {
  const webhookUri = `${ORIGIN}${SHOPIFY_WEBHOOK_PATH}`;
  return {
    name: "ReconcileAI Dev Store",
    // The public API key, the same one production's App Home hands App Bridge
    // (checked against the live page 2026-10-06). Its value is not secret, and
    // asserting it here would only repeat the file.
    client_id: expect.stringMatching(/^[0-9a-f]{32}$/) as unknown as string,
    application_url: `${ORIGIN}${SHOPIFY_APP_HOME_PATH}`,
    embedded: true,
    access_scopes: {
      scopes: SHOPIFY_ORDER_LED_SCOPES.join(","),
      // App Home exchanges a verified App Bridge ID token server-side.
      use_legacy_install_flow: false,
    },
    // Shopify CLI requires the public-app redirect allow-list even when the
    // managed-install path does not navigate through this callback.
    auth: { redirect_urls: [`${ORIGIN}${SHOPIFY_OAUTH_CALLBACK_PATH}`] },
    webhooks: {
      api_version: SHOPIFY_API_VERSION,
      subscriptions: [
        { topics: sorted([...SHOPIFY_ORDER_TRIGGER_TOPICS, SHOPIFY_UNINSTALL_TOPIC]), uri: webhookUri },
        { compliance_topics: sorted(SHOPIFY_PRIVACY_TOPICS), uri: webhookUri },
      ],
    },
    build: { automatically_update_urls_on_dev: false },
  };
}

/** The file as read, with topic lists sorted so their order in the file does not matter. */
function readConfig(source: string): TomlTable {
  const doc = readToml(source);
  const subscriptions = (doc.webhooks as TomlTable | undefined)?.subscriptions;
  if (Array.isArray(subscriptions)) {
    for (const subscription of subscriptions as TomlTable[]) {
      for (const key of ["topics", "compliance_topics"]) {
        if (Array.isArray(subscription[key])) subscription[key] = sorted(subscription[key] as string[]);
      }
    }
  }
  return doc;
}

describe("when shopify.app.toml is read against the code", () => {
  it("should declare exactly the configuration the code serves, each setting in its section", () => {
    expect(readConfig(config)).toEqual(expectedConfig());
  });

  it("should stay inside the read-only Scope A boundary", () => {
    expect(config).not.toMatch(/\bwrite_[a-z_]+\b/);
    expect(config).not.toMatch(/\bread_shopify_payments_[a-z_]+\b/);
    expect(config).not.toMatch(/\bshopify_payments\b/);
    expect(config).not.toMatch(/\bapp_proxy\b/);
  });
});

describe("when a setting is misplaced or added", () => {
  // Greptile #170: the first version found each setting anywhere in the file,
  // so a setting moved out of its section still passed. These prove the
  // comparison above fails for exactly that.
  /** The config with one edit applied, refusing an edit that changes nothing. */
  const edited = (from: string | RegExp, to: string) => {
    const result = config.replace(from, to);
    expect(result, `edit ${String(from)} must change the file`).not.toBe(config);
    return result;
  };
  const matches = (source: string) => {
    try {
      expect(readConfig(source)).toEqual(expectedConfig());
      return true;
    } catch {
      return false;
    }
  };

  it("should fail when api_version moves out of [webhooks]", () => {
    const line = `api_version = "${SHOPIFY_API_VERSION}"`;
    expect(config).toContain(line);
    const moved = line + "\n" + edited(line, "");
    expect(matches(moved)).toBe(false);
  });

  it("should fail when a redirect allow-list or subscription URI is removed, or a scope is added", () => {
    expect(matches(edited(`redirect_urls = ["${ORIGIN}${SHOPIFY_OAUTH_CALLBACK_PATH}"]`, ""))).toBe(false);
    // Shopify sends authorization codes to any URL listed here: an extra entry is
    // a destination for merchants' codes, so exactly one is allowed.
    expect(
      matches(
        edited(
          `redirect_urls = ["${ORIGIN}${SHOPIFY_OAUTH_CALLBACK_PATH}"]`,
          `redirect_urls = ["${ORIGIN}${SHOPIFY_OAUTH_CALLBACK_PATH}", "https://attacker.example/callback"]`,
        ),
      ),
    ).toBe(false);
    expect(matches(edited(/\nuri = "[^"]+"\n/, "\n"))).toBe(false);
    expect(matches(edited('scopes = "read_orders"', 'scopes = "read_orders,read_customers"'))).toBe(false);
  });

  it("should fail when an extra section appears", () => {
    expect(matches(config + '\n[app_preferences]\nurl = "https://example.com"\n')).toBe(false);
  });

  it("should still match when the topics are listed in another order", () => {
    expect(matches(edited('"orders/create",\n  "orders/paid",', '"orders/paid",\n  "orders/create",'))).toBe(true);
  });
});

describe("when the strict TOML reader is given input", () => {
  it("should refuse TOML it does not understand rather than misread it", () => {
    expect(() => readToml("count = 1")).toThrow(/unsupported value/);
    expect(() => readToml('a.b = "x"')).toThrow(/unsupported syntax/);
    expect(() => readToml('name = "a"\nname = "b"')).toThrow(/defined twice/);
    expect(() => readToml("[auth]\n[auth]")).toThrow(/defined twice/);
    expect(() => readToml('note = "a \\" b"')).toThrow(/escape/);
  });

  it("should place each value in the section that holds it", () => {
    expect(readToml('top = "1"\n[webhooks]\napi_version = "2"\n[[webhooks.subscriptions]]\nuri = "3"')).toEqual({
      top: "1",
      webhooks: { api_version: "2", subscriptions: [{ uri: "3" }] },
    });
  });
});
