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
  // The app compiles JSX with React's automatic runtime (@vitejs/plugin-react).
  // tsconfig says "preserve", which leaves vitest on the classic transform, so a
  // test that renders a .tsx page would fail with "React is not defined".
  esbuild: { jsx: "automatic" },
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
      // Operational scripts. Their guards are the tested part — a script that
      // can write to production is only as safe as the check that stops it, and
      // an uncollected test is the same as no test.
      "scripts/**/*.test.ts",
      // CI's own shell scripts. start-test-mysql.sh exists entirely for the
      // case where a registry is down, so a healthy pipeline proves none of
      // its behaviour — the retry, the attempt caps, the container log. Those
      // are exercised here against a fake `docker`.
      ".github/scripts/**/*.test.ts",
    ],
  },
});
