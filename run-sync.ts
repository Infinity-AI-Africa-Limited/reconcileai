import "dotenv/config";
import { syncWoodcoreMirror } from "./server/woodcoreSync";
import { getWoodcorePool } from "./server/woodcoreDb";

async function main() {
  console.log("Starting full mirror sync...\n");
  const state = await syncWoodcoreMirror();
  console.log("\n=== SYNC COMPLETE ===");
  for (const t of state.tables) {
    const flag = t.status === "ok" ? "✅" : t.status === "skipped" ? "⏸️" : "❌";
    console.log(`${flag} ${t.mirror.padEnd(42)} ${String(t.copied).padStart(8)} rows  ${t.status}${t.reason ? `  (${t.reason})` : ""}`);
  }
  console.log(`\nDuration: ${((state.durationMs ?? 0) / 1000 / 60).toFixed(1)} min  |  error: ${state.error ?? "none"}`);
}

main()
  .then(async () => { try { await getWoodcorePool().end(); } catch {} process.exit(0); })
  .catch(async (e) => { console.error("FATAL:", e?.message); try { await getWoodcorePool().end(); } catch {} process.exit(1); });
