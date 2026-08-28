import { NOT_ADMIN_ERR_MSG, UNAUTHED_ERR_MSG } from '@shared/const';
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
});

export const router = t.router;

/**
 * A read-only session may issue queries and nothing else.
 *
 * Applied to the BASE procedure, so every procedure in the application inherits
 * it — including ones written after this and ones whose author never heard of
 * read-only sessions. That is the entire point. The existing guest control
 * (`guestProtectedProcedure`) is opt-in: a procedure is safe only if someone
 * remembered to build it from the guarded builder, and a procedure added to the
 * wrong builder is silently writable. For a link handed to an external reviewer,
 * "safe unless someone forgot" is not a boundary.
 *
 * The rule is an allow-list — `query` passes, everything else is refused — so a
 * new tRPC operation type cannot quietly land on the permitted side. Enumerating
 * what is provably safe and refusing the rest is the same shape as the db:push
 * guard, and for the same reason: a dangerous set can always be re-spelled.
 *
 * `isReadOnly` is a distinct flag from `isGuest` on purpose; see users.isReadOnly.
 */
/**
 * Mutations a read-only session may still call.
 *
 * Only operations that END a session belong here. Logout is a `publicProcedure`
 * mutation, so the blanket ban reached it first and a reviewer pressing "Sign
 * out" was refused — leaving the session alive on the device, which is the
 * opposite of what the control is for. Ending access can never be the thing
 * access control prevents.
 */
const READ_ONLY_ALLOWED_MUTATIONS = new Set<string>(["auth.logout"]);

const refuseReadOnlyWrites = t.middleware(async opts => {
  const { ctx, type, path, next } = opts;

  if (!ctx.user?.isReadOnly) return next();

  // Before anything else, including the liveness check below: a reviewer whose
  // link was just revoked must still be able to clear their own cookie.
  if (READ_ONLY_ALLOWED_MUTATIONS.has(path)) return next();

  if (type !== "query") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "This is a read-only review session. Viewing is permitted; changes are not.",
    });
  }

  /**
   * Revocation has to reach a session that already exists.
   *
   * The session cookie is a stateless JWT: nothing in it is consulted against
   * the link after sign-in, so revoking only stopped NEW exchanges and left
   * every session minted from that link working until its TTL expired — hours.
   * An operator revoking during an incident would reasonably believe access had
   * stopped. So reviewer identities are re-checked on every request, reads
   * included, and the check fails closed.
   *
   * Keyed on the reviewer login method rather than on `isReadOnly`: an operator
   * may mark an ordinary user read-only, and such a user has no link behind
   * them. Keying this on `isReadOnly` would lock those people out of reads.
   */
  if (ctx.user.loginMethod === "reviewer_link") {
    const { isReviewerSessionLive } = await import("../reviewerAccess");
    if (!(await isReviewerSessionLive(ctx.user.id))) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "This review link has been revoked or has expired.",
      });
    }
  }

  return next();
});

const baseProcedure = t.procedure.use(refuseReadOnlyWrites);

export const publicProcedure = baseProcedure;

const requireUser = t.middleware(async opts => {
  const { ctx, next } = opts;

  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }

  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});

export const protectedProcedure = baseProcedure.use(requireUser);

export const adminProcedure = baseProcedure.use(
  t.middleware(async opts => {
    const { ctx, next } = opts;

    if (!ctx.user || ctx.user.role !== 'admin') {
      throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
    }

    return next({
      ctx: {
        ...ctx,
        user: ctx.user,
      },
    });
  }),
);
