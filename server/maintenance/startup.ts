import type { Server } from "node:http";
import { applicationLifecycle, type ApplicationLifecycle } from "./lifecycle";

/**
 * Bind `server` unless shutdown has already begun.
 *
 * Resolves only once the socket is bound. Startup runs as tracked work
 * (`runRoot`), so the drain cannot finish, and shutdown cannot try to close the
 * server, while a listen is still in flight.
 *
 * Resolves false, binding nothing, when the fence is already up. A server that
 * came up now would be fenced, and would outlive the one shutdown attempt that
 * had already run.
 */
export async function listenUnlessFenced(
  server: Server,
  port: number,
  host: string,
  lifecycle: ApplicationLifecycle = applicationLifecycle,
): Promise<boolean> {
  if (!lifecycle.isAcceptingWork()) return false;
  await new Promise<void>((resolve, reject) => {
    const refused = (error: Error) => reject(error);
    server.once("error", refused);
    server.listen(port, host, () => {
      server.off("error", refused);
      resolve();
    });
  });
  return true;
}
