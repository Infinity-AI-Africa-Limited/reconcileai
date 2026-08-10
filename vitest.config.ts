import { defineConfig } from "vitest/config";
import path from "path";

const templateRoot = path.resolve(import.meta.dirname);

export default defineConfig({
  root: templateRoot,
  resolve: {
    alias: {
      "@": path.resolve(templateRoot, "client", "src"),
      "@shared": path.resolve(templateRoot, "shared"),
      "@assets": path.resolve(templateRoot, "attached_assets"),
    },
  },
  test: {
    environment: "node",
    include: [
      "server/**/*.test.ts",
      "server/**/*.spec.ts",
      // Pure (non-DOM) client libraries — e.g. settlement-file connectors.
      "client/src/lib/**/*.test.ts",
      // Build-time code-quality checks that read the source tree. They live
      // outside client/src precisely because they import Node-only tooling —
      // a parser in client source is one careless import away from the bundle.
      "tools/**/*.test.ts",
    ],
  },
});
