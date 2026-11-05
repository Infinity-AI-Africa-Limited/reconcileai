# ReconcileAI production workload preflight: the operator's command.
#
# Defines one shell function, reconcileai_preflight. POSIX sh: it works in
# bash, dash or ash. Paste this whole file into a private terminal inside the
# ACTIVE deployment's container (or source a reviewed copy of it), then run:
#
#   reconcileai_preflight <deployment-id> <commit-sha> [app-dir]
#
#   <deployment-id>  the ACTIVE deployment's full id (a UUID), read from the
#                    Railway dashboard immediately before the run
#   <commit-sha>     the full 40-character commit that deployment runs
#   [app-dir]        the application directory, /app by default
#
# It runs the pinned preflight once: 3 samples, 60 seconds apart, inside a
# 300-second budget, stopped at 360 seconds whatever happens. The preflight
# reads the database and Redis and changes nothing; this routine changes nothing
# either, except one private directory it makes for the probe's code and removes
# again on success, on failure, and on a handled interruption (Ctrl-C, hang-up,
# termination). SIGKILL, or the container going away, leaves that directory
# behind; it holds only the probe's code.
#
# In order, stopping at the first failure with a fixed code:
#   1. checks its arguments, the tools it needs and the application directory;
#   2. creates its own directory with mktemp -d (mode 0700): no fixed path, so
#      no stale or shared file is ever read, overwritten or deleted;
#   3. downloads the probe from GitHub at the pinned commit, over HTTPS only;
#   4. checks its SHA-256 against the pinned value, then makes it read-only;
#   5. runs it under `timeout`, through a loader that reads the file ONCE, checks
#      the same SHA-256 on those bytes, and executes exactly them, so a file
#      replaced after step 4 is never run;
#   6. removes its directory, and exits with the probe's own status.
#
# Output: the probe's stdout alone (one JSON line, a VERDICT line and a GROUPS
# line; or one JSON line with a fixed error code). This routine's own failures
# are one line on stderr: "PREFLIGHT_WRAPPER: <code>".
#
# Exit statuses:
#    0 report printed; read its VERDICT (0 is never approval)
#    2 the probe refused its options       3 the probe failed
#    4 the probe refused the target (identity or route), before connecting
#    5 the probe was interrupted
#   10 usage                               11 a tool is missing or unsuitable
#   12 an expected identity is malformed   13 the application directory is unusable
#   14 the private directory failed        15 the download failed
#   16 the checksum did not match          17 this routine was interrupted
#  124 the time limit stopped the probe   137 ...and it had to be killed
#
# Pinned: scripts/production-workload-preflight.mjs at PROBE_COMMIT, whose
# SHA-256 is PROBE_SHA256. scripts/productionWorkloadPreflightWrapper.test.ts
# fails when they stop matching the committed probe.

reconcileai_preflight() (
  readonly PROBE_COMMIT="6c9243f20837ca8ef13c9edacdd39e4234461774"
  readonly PROBE_SHA256="9cf0ee931d3643a4b2367e985d2d779d8569a7eea72dffb5c887fb5ee4a31aab"
  readonly PROBE_URL="https://raw.githubusercontent.com/Infinity-AI-Africa-Limited/reconcileai/${PROBE_COMMIT}/scripts/production-workload-preflight.mjs"
  readonly SAMPLES=3
  readonly INTERVAL_SECONDS=60
  readonly BUDGET_SECONDS=300
  readonly HARD_LIMIT_MARGIN_SECONDS=60
  readonly KILL_AFTER_SECONDS=10
  # JavaScript run by node. It reads the probe once, checks those bytes, and
  # runs exactly them.
  readonly LOADER='
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const [file, expected, ...args] = process.argv.slice(1);
const stop = (error, status) => {
  process.stdout.write(JSON.stringify({ schema: "reconcileai_workload_preflight_v2", error }) + "\n");
  process.exit(status);
};
let bytes;
try {
  bytes = readFileSync(file);
} catch {
  stop("probe_unreadable", 16);
}
if (createHash("sha256").update(bytes).digest("hex") !== expected) stop("probe_checksum_mismatch", 16);
let probe;
try {
  probe = await import("data:text/javascript;base64," + bytes.toString("base64"));
} catch {
  stop("probe_load_failed", 3);
}
if (typeof probe.main !== "function") stop("probe_load_failed", 3);
await probe.main(args);
'

  # The operator's shell options must not change what follows: errors are
  # checked one by one, nothing is traced, and cd goes only where it is told.
  set -u +e +x
  CDPATH=
  workdir=""
  probe_pid=""

  fail() {
    printf 'PREFLIGHT_WRAPPER: %s\n' "$1" >&2
    exit "$2"
  }

  cleanup() {
    # A second Ctrl-C must not cut the cleanup short.
    trap '' INT TERM HUP
    if [ -n "$probe_pid" ]; then
      # timeout passes the signal on, and kills after KILL_AFTER_SECONDS.
      kill -TERM "$probe_pid" 2>/dev/null
      wait "$probe_pid" 2>/dev/null
      probe_pid=""
    fi
    # Only the directory this run made, and only while it still is one.
    if [ -n "$workdir" ] && [ -d "$workdir" ] && [ ! -L "$workdir" ]; then
      chmod -R u+w -- "$workdir" 2>/dev/null
      rm -rf -- "$workdir"
    fi
  }
  trap cleanup EXIT
  trap 'fail interrupted 17' INT TERM HUP

  [ "$#" -ge 2 ] && [ "$#" -le 3 ] || fail usage 10
  deployment=$1
  commit=$2
  app_dir=${3:-/app}

  for tool in node curl sha256sum mktemp timeout chmod rm; do
    command -v "$tool" >/dev/null 2>&1 || fail "missing_${tool}" 11
  done
  node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' >/dev/null 2>&1 || fail node_too_old 11
  timeout --signal=TERM --kill-after=1 5 true >/dev/null 2>&1 || fail timeout_unsupported 11

  # The probe checks these again, and refuses placeholders.
  h='[0123456789abcdef]'
  h4="$h$h$h$h"
  h8="$h4$h4"
  case $deployment in
    $h8-$h4-$h4-$h4-$h8$h4) ;;
    *) fail expected_deployment_malformed 12 ;;
  esac
  case $commit in
    $h8$h8$h8$h8$h8) ;;
    *) fail expected_commit_malformed 12 ;;
  esac

  [ -d "$app_dir" ] && [ -f "$app_dir/package.json" ] && [ -f "$app_dir/dist/index.js" ] || fail app_dir_invalid 13
  (cd -- "$app_dir" && node -e 'require.resolve("mysql2/promise"); require.resolve("bullmq")') >/dev/null 2>&1 \
    || fail app_dependencies_missing 13

  tmp_root=${TMPDIR:-/tmp}
  workdir=$(mktemp -d "${tmp_root%/}/reconcileai-preflight.XXXXXXXXXX" 2>/dev/null) || { workdir=""; fail workdir_failed 14; }
  case $workdir in
    /*) ;;
    *) fail workdir_failed 14 ;;
  esac
  chmod 0700 -- "$workdir" || fail workdir_failed 14
  probe="$workdir/probe.mjs"

  # -q first: no .curlrc can change what this does.
  curl -q --fail --silent --proto '=https' --tlsv1.2 --max-time 60 --output "$probe" -- "$PROBE_URL" >/dev/null 2>&1 \
    || fail download_failed 15
  actual=$(sha256sum -- "$probe" 2>/dev/null) || fail checksum_mismatch 16
  [ "${actual%% *}" = "$PROBE_SHA256" ] || fail checksum_mismatch 16
  { chmod 0400 -- "$probe" && chmod 0500 -- "$workdir"; } || fail workdir_failed 14

  cd -- "$app_dir" || fail app_dir_invalid 13
  # In the background, so a signal reaches the trap above while the probe runs.
  timeout --signal=TERM --kill-after="$KILL_AFTER_SECONDS" "$((BUDGET_SECONDS + HARD_LIMIT_MARGIN_SECONDS))" \
    node --no-warnings --input-type=module -e "$LOADER" -- "$probe" "$PROBE_SHA256" \
      --env-from-app --expect-deployment "$deployment" --expect-commit "$commit" \
      --samples "$SAMPLES" --interval-seconds "$INTERVAL_SECONDS" --budget-seconds "$BUDGET_SECONDS" &
  probe_pid=$!
  wait "$probe_pid"
  status=$?
  probe_pid=""
  case $status in
    124 | 137) fail probe_time_limit "$status" ;;
  esac
  exit "$status"
)
