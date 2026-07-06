/**
 * Connector config persistence: load a WcConnectorConfig row and hydrate it
 * into a ready-to-use WcConnection (secrets decrypted, endpoints merged).
 */
import { eq } from "drizzle-orm";
import { wcConnectorConfigs, type WcConnectorConfig } from "../../../drizzle/connector_schema";
import { getDb } from "../../db";
import { getCbsProfile } from "../cbs/registry";
import { decryptSecretForOrg } from "./secrets";
import { DEFAULT_ENDPOINTS, type WcConnection, type WcEndpoints } from "./types";

export function mergeEndpoints(overrides: unknown, defaults: WcEndpoints = DEFAULT_ENDPOINTS): WcEndpoints {
  const o = (overrides ?? {}) as Partial<Record<keyof WcEndpoints, unknown>>;
  const merged: WcEndpoints = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof WcEndpoints)[]) {
    const v = o[key];
    if (typeof v === "string" && v.trim()) merged[key] = v.trim();
  }
  return merged;
}

export async function toConnection(row: WcConnectorConfig): Promise<WcConnection> {
  const profile = getCbsProfile(row.cbsType);
  const orgId = row.organizationId;
  return {
    configId: row.id,
    organizationId: orgId,
    cbsType: profile.type,
    baseUrl: row.baseUrl,
    tenantId: row.tenantId,
    authMode: row.authMode,
    oauthClientId: row.oauthClientId,
    oauthClientSecret: await decryptSecretForOrg(row.oauthClientSecretEnc, orgId),
    oauthTokenUrl: row.oauthTokenUrl,
    oauthScope: row.oauthScope,
    apiKey: await decryptSecretForOrg(row.apiKeyEnc, orgId),
    apiKeyHeader: row.apiKeyHeader,
    basicUsername: row.basicUsername,
    basicPassword: await decryptSecretForOrg(row.basicPasswordEnc, orgId),
    pageSize: row.pageSize,
    maxRetries: row.maxRetries,
    requestTimeoutMs: row.requestTimeoutMs,
    endpoints: mergeEndpoints(row.endpointsJson, profile.defaultEndpoints),
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
  return row ? await toConnection(row) : null;
}

export async function listEnabledConfigs(): Promise<WcConnectorConfig[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(wcConnectorConfigs).where(eq(wcConnectorConfigs.isEnabled, true));
}
