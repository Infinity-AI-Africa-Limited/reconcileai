/**
 * Bucket (object-storage) drop ingestion — tRPC surface.
 *
 * The S3-compatible sibling of the SFTP config router. Written org-scoped from
 * the first line rather than retrofitted: the SFTP equivalent keyed every
 * accessor on a bare `id`, which let one institution read, repoint or delete
 * another's bank feed (fixed in #32). These rows hold the same class of secret —
 * bucket names, endpoints and encrypted access keys — so every procedure here
 * proves ownership before it acts, and rejections are uniformly NOT_FOUND so
 * they cannot be used to enumerate other tenants' sources.
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { bucketIngestionSources, bucketIngestionLogs } from "../../drizzle/schema";
import { adminProcedure, protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import {
  encryptCredential,
  testBucketConnection,
  listBucketFiles,
  downloadAndProcessBucketObject,
} from "../bucketIngestionService";

/** The caller's organization, or a hard failure. Bucket feeds are institutional. */
function requireOrg(user: { organizationId?: number | null }): number {
  if (!user.organizationId) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Your account is not linked to an organization",
    });
  }
  return user.organizationId;
}

/**
 * Load a source and prove the caller's org owns it.
 * Throws NOT_FOUND whether it is missing or someone else's — the distinction
 * would be an enumeration oracle.
 */
async function ownedSource(
  user: { organizationId?: number | null },
  id: number,
) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  const [src] = await db
    .select()
    .from(bucketIngestionSources)
    .where(and(eq(bucketIngestionSources.id, id), eq(bucketIngestionSources.organizationId, requireOrg(user))))
    .limit(1);
  if (!src) throw new TRPCError({ code: "NOT_FOUND", message: "Bucket source not found" });
  return { db, src };
}

/** Connection settings shared by create and testConnection. */
const connectionInput = {
  provider: z.enum(["s3", "r2", "minio", "other"]).default("s3"),
  bucket: z.string().min(1).max(255),
  prefix: z.string().max(500).default(""),
  region: z.string().min(1).max(64).default("auto"),
  endpoint: z.string().max(500).optional(),
  accessKeyId: z.string().max(255).optional(),
  secretAccessKey: z.string().max(255).optional(),
  filePattern: z.string().min(1).max(255).default("*.csv"),
};

export const bucketIngestionRouter = router({
  /** Sources for the caller's organization. Never another tenant's. */
  list: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
    const rows = await db
      .select()
      .from(bucketIngestionSources)
      .where(eq(bucketIngestionSources.organizationId, requireOrg(ctx.user)))
      .orderBy(desc(bucketIngestionSources.createdAt));
    // Never return the encrypted key material to the browser — the UI only
    // needs to know WHETHER credentials are set.
    return rows.map(({ accessKeyIdEncrypted, secretAccessKeyEncrypted, ...rest }) => ({
      ...rest,
      hasCredentials: Boolean(accessKeyIdEncrypted && secretAccessKeyEncrypted),
    }));
  }),

  /**
   * Verify bucket access and the file pattern without saving anything.
   * Takes raw connection settings (nothing persisted yet), so there is no id to
   * scope — but it also cannot touch an existing source.
   */
  testConnection: adminProcedure
    .input(z.object(connectionInput))
    .mutation(async ({ input }) => {
      return testBucketConnection({
        bucket: input.bucket,
        prefix: input.prefix,
        region: input.region,
        endpoint: input.endpoint ?? null,
        filePattern: input.filePattern,
        accessKeyIdEncrypted: input.accessKeyId ? encryptCredential(input.accessKeyId) : null,
        secretAccessKeyEncrypted: input.secretAccessKey ? encryptCredential(input.secretAccessKey) : null,
      });
    }),

  create: adminProcedure
    .input(
      z.object({
        ...connectionInput,
        name: z.string().min(1).max(255),
        channelId: z.number().int().positive(),
        archivePrefix: z.string().max(500).optional(),
        deleteAfterProcess: z.boolean().default(false),
        pollingEnabled: z.boolean().default(true),
        pollingIntervalMinutes: z.number().int().min(5).max(1440).default(15),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const organizationId = requireOrg(ctx.user);

      // A custom endpoint is mandatory for non-AWS providers; without it the
      // SDK silently talks to AWS and the source would never find a file.
      if (input.provider !== "s3" && !input.endpoint) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `An endpoint is required for ${input.provider}`,
        });
      }

      const [res] = await db.insert(bucketIngestionSources).values({
        organizationId,
        userId: ctx.user.id,
        name: input.name,
        provider: input.provider,
        bucket: input.bucket,
        prefix: input.prefix,
        region: input.region,
        endpoint: input.endpoint ?? null,
        accessKeyIdEncrypted: input.accessKeyId ? encryptCredential(input.accessKeyId) : null,
        secretAccessKeyEncrypted: input.secretAccessKey ? encryptCredential(input.secretAccessKey) : null,
        filePattern: input.filePattern,
        archivePrefix: input.archivePrefix || null,
        deleteAfterProcess: input.deleteAfterProcess,
        channelId: input.channelId,
        pollingEnabled: input.pollingEnabled,
        pollingIntervalMinutes: input.pollingIntervalMinutes,
        isActive: true,
      });
      return { id: res.insertId };
    }),

  update: adminProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        name: z.string().min(1).max(255).optional(),
        prefix: z.string().max(500).optional(),
        filePattern: z.string().min(1).max(255).optional(),
        archivePrefix: z.string().max(500).optional(),
        deleteAfterProcess: z.boolean().optional(),
        pollingEnabled: z.boolean().optional(),
        pollingIntervalMinutes: z.number().int().min(5).max(1440).optional(),
        isActive: z.boolean().optional(),
        accessKeyId: z.string().max(255).optional(),
        secretAccessKey: z.string().max(255).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { db, src } = await ownedSource(ctx.user, input.id);
      const patch: Record<string, unknown> = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.prefix !== undefined) patch.prefix = input.prefix;
      if (input.filePattern !== undefined) patch.filePattern = input.filePattern;
      if (input.archivePrefix !== undefined) patch.archivePrefix = input.archivePrefix || null;
      if (input.deleteAfterProcess !== undefined) patch.deleteAfterProcess = input.deleteAfterProcess;
      if (input.pollingEnabled !== undefined) patch.pollingEnabled = input.pollingEnabled;
      if (input.pollingIntervalMinutes !== undefined) patch.pollingIntervalMinutes = input.pollingIntervalMinutes;
      if (input.isActive !== undefined) patch.isActive = input.isActive;
      if (input.accessKeyId) patch.accessKeyIdEncrypted = encryptCredential(input.accessKeyId);
      if (input.secretAccessKey) patch.secretAccessKeyEncrypted = encryptCredential(input.secretAccessKey);

      await db
        .update(bucketIngestionSources)
        .set(patch)
        .where(eq(bucketIngestionSources.id, src.id));
      return { success: true };
    }),

  delete: adminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const { db, src } = await ownedSource(ctx.user, input.id);
      await db.delete(bucketIngestionSources).where(eq(bucketIngestionSources.id, src.id));
      return { success: true };
    }),

  /** Objects currently sitting in the bucket that match the source's pattern. */
  listFiles: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const { src } = await ownedSource(ctx.user, input.id);
      return listBucketFiles(src.id);
    }),

  /** Ingest one object on demand, rather than waiting for the poll. */
  processObject: adminProcedure
    .input(z.object({ id: z.number().int().positive(), objectKey: z.string().min(1).max(1000) }))
    .mutation(async ({ ctx, input }) => {
      const { src } = await ownedSource(ctx.user, input.id);
      return downloadAndProcessBucketObject(src.id, input.objectKey);
    }),

  /** Ingestion history for one source, or for the whole organization. */
  logs: protectedProcedure
    .input(
      z.object({
        sourceId: z.number().int().positive().optional(),
        limit: z.number().int().min(1).max(200).default(50),
      }),
    )
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const organizationId = requireOrg(ctx.user);
      // Both predicates are AND-ed into ONE where(). Chaining .where() in
      // drizzle REPLACES rather than combines — that is exactly how the SFTP
      // log reader ended up returning every tenant's history (#32).
      const conditions = [eq(bucketIngestionLogs.organizationId, organizationId)];
      if (input.sourceId) conditions.push(eq(bucketIngestionLogs.bucketSourceId, input.sourceId));
      return db
        .select()
        .from(bucketIngestionLogs)
        .where(and(...conditions))
        .orderBy(desc(bucketIngestionLogs.createdAt))
        .limit(input.limit);
    }),
});
