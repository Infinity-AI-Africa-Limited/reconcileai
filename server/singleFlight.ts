/**
 * Wrap a periodic task so at most one run is in flight at a time in this
 * process.
 *
 * On a timer, a sweep slower than its interval would otherwise start another
 * beside it, and under a slow database they pile up until they exhaust the
 * connection pool — precisely when the pool is least able to spare them. A tick
 * that finds a run still going is skipped; the next tick tries again.
 *
 * It lives here rather than beside any one caller: the Shopify privacy sweep
 * and the order backstop both need it, and the backstop must keep running in
 * exactly the situation where the privacy queue cannot start, so it should not
 * import that subsystem to get a helper.
 */
export function singleFlight(task: () => Promise<void>): () => Promise<void> {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      await task();
    } finally {
      running = false;
    }
  };
}
