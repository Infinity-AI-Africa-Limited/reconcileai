import type { Response } from "express";
import { runBackgroundWork } from "./lifecycle";

/** Reserve now, not when the immediate fires after its parent has settled. */
export function deferBackgroundWork(operation: () => Promise<unknown>): void {
  runBackgroundWork(() => new Promise((resolve, reject) => {
    setImmediate(() => {
      try {
        Promise.resolve(operation()).then(resolve, reject);
      } catch (error) {
        reject(error);
      }
    });
  }));
}

/**
 * Reserve the follow-up before returning the handler. Finish is evidence that
 * the response was sent; an aborted close releases the wait without running it.
 * A close AFTER finish must not release an in-flight asynchronous follow-up.
 */
export function trackResponseCompletion(res: Response, onFinish: () => Promise<unknown>): void {
  runBackgroundWork(async () => {
    const finished = await new Promise<boolean>(resolve => {
      let settled = false;
      const settle = (sent: boolean) => {
        if (settled) return;
        settled = true;
        res.removeListener("finish", finish);
        res.removeListener("close", close);
        resolve(sent);
      };
      const finish = () => settle(true);
      const close = () => settle(false);
      res.once("finish", finish);
      res.once("close", close);
      // Also handle callers observing a response that has already completed.
      if (res.writableFinished) finish();
      else if (res.destroyed) close();
    });
    // The continuation runs in the reserved task's ALS context, not in the
    // socket event emitter's potentially expired request context.
    if (finished) await onFinish();
  });
}
