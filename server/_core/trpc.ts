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
const refuseReadOnlyWrites = t.middleware(async opts => {
  const { ctx, type, next } = opts;

  if (ctx.user?.isReadOnly && type !== "query") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "This is a read-only review session. Viewing is permitted; changes are not.",
    });
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
