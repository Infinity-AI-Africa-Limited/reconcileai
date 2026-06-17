import { z } from "zod";
import { notifyOwner } from "./notification";
import { describeResidencyPosture } from "./egress";
import { adminProcedure, publicProcedure, router } from "./trpc";

export const systemRouter = router({
  health: publicProcedure
    .input(
      z.object({
        timestamp: z.number().min(0, "timestamp cannot be negative"),
      })
    )
    .query(() => ({
      ok: true,
    })),

  // Data-residency posture, so operators (and the customer's own security team)
  // can verify at runtime whether external egress is enforced. Non-sensitive.
  residencyStatus: publicProcedure.query(() => describeResidencyPosture()),

  notifyOwner: adminProcedure
    .input(
      z.object({
        title: z.string().min(1, "title is required"),
        content: z.string().min(1, "content is required"),
      })
    )
    .mutation(async ({ input }) => {
      const delivered = await notifyOwner(input);
      return {
        success: delivered,
      } as const;
    }),
});
