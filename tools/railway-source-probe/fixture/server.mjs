// Railway source probe: a deliberately tiny HTTP server for a separate,
// non-production Railway project. It reports which source commit a deployment
// built, when its image was built, and which value of one dummy variable it
// received. Nothing else.
//
// It makes no outbound connection, and reads only the environment variables
// named below, so it cannot print a secret even if one is set on its service.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const here = new URL(".", import.meta.url);

function readText(name, fallback) {
  try {
    return readFileSync(new URL(name, here), "utf8").trim();
  } catch {
    return fallback;
  }
}

function builtAt() {
  const raw = readText("build-info.json", "");
  if (raw === "") return "not built";
  try {
    const value = JSON.parse(raw).builtAt;
    return typeof value === "string" ? value : "unreadable";
  } catch {
    return "unreadable";
  }
}

// A dummy marker such as v1. Any other value is not echoed, in case a real
// value is set on this variable by mistake.
function probeVariable() {
  const value = process.env.PROBE_VARIABLE;
  if (value === undefined) return "unset";
  return /^v\d{1,3}$/.test(value) ? value : "set (not shown)";
}

// Railway's own identifiers (docs.railway.com/variables/reference).
function railway(name) {
  const value = process.env[name];
  return value === undefined || value === "" ? "unset" : value.replace(/\s+/g, "_").slice(0, 80);
}

const report = {
  marker: readText("MARKER", "missing"),
  builtAt: builtAt(),
  probeVariable: probeVariable(),
  railwayCommit: railway("RAILWAY_GIT_COMMIT_SHA"),
  railwayBranch: railway("RAILWAY_GIT_BRANCH"),
  railwayDeployment: railway("RAILWAY_DEPLOYMENT_ID"),
  railwaySnapshot: railway("RAILWAY_SNAPSHOT_ID"),
  startedAt: new Date().toISOString(),
};

function line(event) {
  const fields = Object.entries(report).map(([key, value]) => `${key}=${value}`);
  return `[probe] ${event} ${fields.join(" ")}`;
}

const server = createServer((request, response) => {
  if (request.method !== "GET") {
    response.writeHead(405).end();
  } else if (request.url === "/healthz") {
    response.writeHead(200, { "content-type": "text/plain" }).end("ok");
  } else if (request.url === "/") {
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(report));
  } else {
    response.writeHead(404).end();
  }
});

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
server.listen(Number.isInteger(port) && port > 0 && port < 65536 ? port : 3000, () => {
  console.log(line("start"));
});

function stop(signal) {
  console.log(line(`stop signal=${signal}`));
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
