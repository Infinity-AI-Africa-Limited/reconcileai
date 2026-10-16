/**
 * The one way server code stores a file holding a tenant's data.
 *
 * Two rules, both so that erasing a tenant can find and delete every file:
 *
 *   - The key goes under the tenant's own prefix (`tenantObjectKey`), so
 *     erasure lists `org/<id>/` and deletes what is there. A file keyed by the
 *     uploader's user id can be traced to a tenant only through that user's
 *     CURRENT organisation, which changes when a user moves — and staff who
 *     export a tenant's job belong to no tenant at all.
 *   - A tenant that is being deleted accepts no new files. Erasure lists the
 *     prefix and deletes what it found; a file written after that listing
 *     would outlive the tenant.
 *
 * `server/storageUploadGate.test.ts` fails CI when other server code uploads
 * directly, so a new export cannot quietly bring back user-keyed files.
 */
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { isTenantId } from "@shared/tenantId";
import { organizations } from "../drizzle/schema";
import { getDb } from "./db";
import { storagePut, tenantObjectKey } from "./storage";

/** The modules whose CSV exports `trackAndUploadCsvExport` records. */
export const CSV_EXPORT_MODULES = ["cbn", "cfo", "reconciliation"] as const;
export type CsvExportModule = (typeof CSV_EXPORT_MODULES)[number];

/** Where a user's download of a tenant's data is kept, relative to the tenant's prefix. */
export function userExportPath(userId: number, fileName: string): string {
  return `exports/${userId}/${fileName}`;
}

/** Where a tracked CSV export is kept, relative to the tenant's prefix. */
export function csvExportPath(module: CsvExportModule, userId: number, fileName: string): string {
  return `csv-exports/${module}/${userId}/${fileName}`;
}

/**
 * Folders that held a user's files before files were keyed by tenant. Erasure
 * sweeps them for the tenant's own users; nothing writes there for a tenant now.
 */
export function legacyUserFilePrefixes(userId: number): string[] {
  return [`exports/${userId}/`, ...CSV_EXPORT_MODULES.map((module) => `csv-exports/${module}/${userId}/`)];
}

export const TENANT_FILES_CLOSED_MESSAGE =
  "This workspace is being deleted, so no new files can be stored for it.";

/** Refuse a new file for a tenant that is not active — being deleted, or gone. */
export async function assertTenantAcceptsFiles(organizationId: number): Promise<void> {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  const [organization] = await db
    .select({ deletionState: organizations.deletionState })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  if (organization?.deletionState !== "active") {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: TENANT_FILES_CLOSED_MESSAGE });
  }
}

/**
 * Store a file holding `organizationId`'s data and return its key and a
 * presigned download URL. With no tenant (data that belongs to none) the
 * relative key is used as it is.
 */
export async function putTenantObject(params: {
  organizationId: number | null | undefined;
  relKey: string;
  body: Buffer | Uint8Array | string;
  contentType: string;
}): Promise<{ key: string; url: string }> {
  if (isTenantId(params.organizationId)) await assertTenantAcceptsFiles(params.organizationId);
  return storagePut(tenantObjectKey(params.organizationId, params.relKey), params.body, params.contentType);
}
