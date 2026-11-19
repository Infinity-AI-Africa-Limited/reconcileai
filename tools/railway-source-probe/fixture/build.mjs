// Runs as the build step (Railpack runs the "build" script). It records when
// the image was built, so a deployment that reuses an image can be told apart
// from one that rebuilt it. Nothing else.
import { writeFileSync } from "node:fs";

writeFileSync(
  new URL("build-info.json", import.meta.url),
  `${JSON.stringify({ builtAt: new Date().toISOString() })}\n`,
);
console.log("[probe] build recorded");
