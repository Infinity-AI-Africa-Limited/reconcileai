/**
 * Connector config persistence: load a WcConnectorConfig row and hydrate it
 * into a ready-to-use WcConnection (secrets decrypted, endpoints merged).
 */
import { eq } from "drizzle-orm";
import { wcConnectorConfigs, type WcConnectorConfig } from "../../../drizzle/connector_schema";
import { getDb } from "../../db";
import { decryptSecret } from "./secrets";
import { DEFAULT_ENDPOINTS, type WcConnection, type WcEndpoints } from "./types";

export function mergeEndpoints(overrides: unknown): WcEndpoints {
  const o = (overrides ?? {}) as Partial<Record<keyof WcEndpoints, unknown>>;
  const merged: WcEndpoints = { ...DEFAULT_ENDPOINTS };
  for (const key of Object.keys(DEFAULT_ENDPOINTS) as (keyof WcEndpoints)[]) {
    const v = o[key];
    if (typeof v === "string" && v.trim()) merged[key] = v.trim();
  }
  return merged;
}

export function toConnection(row: WcConnectorConfig): WcConnection {
  return {
    configId: row.id,
    organizationId: row.organizationId,
    baseUrl: row.baseUrl,
    tenantId: row.tenantId,
    authMode: row.authMode,
    oauthClientId: row.oauthClientId,
    oauthClientSecret: decryptSecret(row.oauthClientSecretEnc),
    oauthTokenUrl: row.oauthTokenUrl,
    oauthScope: row.oauthScope,
    apiKey: decryptSecret(row.apiKeyEnc),
    apiKeyHeader: row.apiKeyHeader,
    basicUsername: row.basicUsername,
    basicPassword: decryptSecret(row.basicPasswordEnc),
    pageSize: row.pageSize,
    maxRetries: row.maxRetries,
    requestTimeoutMs: row.requestTimeoutMs,
    endpoints: mergeEndpoints(row.endpointsJson),
  };
}

export async function getConfigRow(configId: number): Promise<WcConnectorConfig | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select()
    .from(wcConnectorConfigs)
    .where(eq(wcConnectorConfigs.id, configId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getConfigRowByOrg(organizationId: number): Promise<WcConnectorConfig | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select()
    .from(wcConnectorConfigs)
    .where(eq(wcConnectorConfigs.organizationId, organizationId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getConnection(configId: number): Promise<WcConnection | null> {
  const row = await getConfigRow(configId);
  return row ? toConnection(row) : null;
}

export async function listEnabledConfigs(): Promise<WcConnectorConfig[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(wcConnectorConfigs).where(eq(wcConnectorConfigs.isEnabled, true));
}
