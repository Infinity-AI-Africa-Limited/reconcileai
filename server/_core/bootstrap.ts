import "dotenv/config";
import { readDrainTimeout, readStartupMode, selectStartup } from "../maintenance/config";
import { startMaintenanceServer } from "../maintenance/coldServer";

async function bootstrap(): Promise<void> {
  // Validate both controls before any normal application import can start a writer.
  const mode = readStartupMode(process.env.RECONCILEAI_STARTUP_MODE);
  readDrainTimeout(process.env.RECONCILEAI_DRAIN_TIMEOUT_MS);
  await selectStartup(mode, {
    normal: () => import("./index"),
    maintenance: async () => {
      const rawPort = process.env.PORT ?? "3000";
      const port = /^\d+$/.test(rawPort) ? Number(rawPort) : NaN;
      if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("invalid_port");
      const server = await startMaintenanceServer(port);
      const stop = () => server.close(() => { process.exitCode = 0; });
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
      console.log("[boot] maintenance_only");
    },
  });
}

void bootstrap().catch(() => {
  // No error values, environment data, connection strings or stack arguments.
  console.error("[boot] startup_failed");
  process.exitCode = 1;
});
