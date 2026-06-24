/**
 * Load exceljs in a way that survives our ESM server bundle.
 *
 * The server is bundled as ESM (`esbuild --format=esm --packages=external`), so at
 * runtime `await import("exceljs")` goes through Node's ESM→CJS interop. exceljs@4
 * is CommonJS with no `exports` map, so its `module.exports` (which holds
 * `Workbook`, etc.) arrives under the namespace's `.default` rather than as
 * top-level named exports. Reaching for `mod.Workbook` directly then yields
 * `undefined` → "ExcelJS.Workbook is not a constructor".
 *
 * Always obtain ExcelJS through this loader. `mod.default ?? mod` resolves the
 * constructor correctly under both the production ESM bundle and dev/test runners.
 */
export async function loadExcelJS(): Promise<typeof import("exceljs")> {
  const mod = (await import("exceljs")) as unknown as Record<string, unknown>;
  return (mod.default ?? mod) as typeof import("exceljs");
}
