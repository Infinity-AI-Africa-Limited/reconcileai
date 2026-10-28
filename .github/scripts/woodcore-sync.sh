#!/usr/bin/env bash
#
# Woodcore mirror sync: start it, then wait for its real result.
#
# POST /api/woodcore/sync answers 202 before the sync touches either database;
# the sync then runs in the background on the server. Until 2026-10-28 the job
# stopped at the 202, so it was green whatever the sync did. It stayed green
# through the production database outage that began on 2026-10-26, while every
# table failed to write.
#
# It now polls GET /api/woodcore/sync until that run finishes, and fails when:
#   - the run reports an error, or any table reports status "error";
#   - the run is no longer visible on the server (a restart or deploy lost it);
#   - the status endpoint stops answering; or
#   - the run is still going at the deadline.
# A "skipped" table is a warning, not a failure. The two bridge tables are
# refused to the Woodcore user today, and a skip never empties a mirror.
#
# The repository is public, so its Actions logs are too. Nothing from a
# response is printed except fields this script chooses: table names,
# statuses, row counts, and a failure reason only in its code-only form
# ("database error (CODE)"). Any other reason can name a host, so it stays in
# the server log.
#
# Run by .github/workflows/woodcore-sync.yml, and by woodcoreSync.test.ts next
# to this file, against a fake server.

set -uo pipefail

SYNC_URL="${SYNC_URL:?SYNC_URL is not set}"
OIDC_AUDIENCE="${OIDC_AUDIENCE:-}"
SYNC_SECRET="${SYNC_SECRET:-}"
SECRET_SOURCE="${SECRET_SOURCE:-none}"
POLL_INTERVAL_SECONDS="${WOODCORE_SYNC_POLL_INTERVAL_SECONDS:-30}"
DEADLINE_SECONDS="${WOODCORE_SYNC_DEADLINE_SECONDS:-3000}"
# How many polls in a row may miss this run, or fail outright, before the job
# gives up. A single blip (a 502 from the proxy) is not a verdict.
LOST_RUN_POLLS=3
STATUS_FAILURE_POLLS=5
# A 202's run has no id, so it is recognised by its start time. The runner's
# clock and the server's may differ by this much.
CLOCK_SKEW_SECONDS=120
REQUEST_TIMEOUT_SECONDS=30

if ! command -v jq >/dev/null 2>&1; then
  echo "::error::jq is required to read the sync's status, and it is not installed."
  exit 1
fi

response=$(mktemp)
trap 'rm -f "$response"' EXIT

# Ask GitHub for a short-lived token identifying this run. The server verifies
# its signature and, critically, the `repository` claim — so nothing long-lived
# is copied between two dashboards and there is nothing to rotate out of step.
# That copying is what broke this job on 2026-08-02 and left the mirror stale
# for three days.
#
# Best-effort on purpose: the secret header is still sent alongside, so a
# deployment that has not yet set GITHUB_OIDC_* keeps working unchanged. Once
# the server logs `[syncAuth] authorized ... via github_oidc`, the secret header
# and the repo secrets can both go.
#
# A fresh token for every request: a long sync can outlive one.
oidc_token() {
  if [ -z "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ]; then return 0; fi
  curl -sS --max-time "$REQUEST_TIMEOUT_SECONDS" \
    -H "Authorization: bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" \
    "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=$OIDC_AUDIENCE" \
    | sed -n 's/.*"value":"\([^"]*\)".*/\1/p'
}

# One authenticated request to the sync endpoint. The body lands in $response;
# the HTTP status is printed, "000" when nothing answered.
call_sync() {
  local method=$1 token
  token=$(oidc_token)
  curl -sS --max-time "$REQUEST_TIMEOUT_SECONDS" -o "$response" -w "%{http_code}" -X "$method" \
    ${SYNC_SECRET:+-H "x-sync-secret: $SYNC_SECRET"} \
    ${token:+-H "Authorization: Bearer $token"} \
    "$SYNC_URL" || true
}

# The response's own `error` field, only when it is a short plain word or two.
error_field() {
  jq -r 'if type == "object" and (.error | type) == "string" and (.error | test("^[A-Za-z0-9 _.-]{1,60}$"))
         then " (\(.error))" else "" end' "$response" 2>/dev/null || true
}

# Seconds since the epoch for one of the server's ISO timestamps; empty if unreadable.
epoch() {
  jq -rn --arg t "$1" '$t | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601' 2>/dev/null || true
}

# ── Credentials ─────────────────────────────────────────────────────────────
#
# Refuse LOUDLY when neither credential is available, rather than skipping.
# A check that exited 0 here would let the last documented rollout step —
# deleting the repo secrets once OIDC is proven — report every run GREEN while
# syncing nothing. That is strictly worse than the outage this job exists to
# prevent: the 2026-08-02 drift was at least caught by a failure email, and a
# green skip sends none.
#
# The mirror repository is handled by the job-level `if:` in the workflow, so
# reaching here without a credential is a real fault on the canonical repo.
OIDC_TOKEN=$(oidc_token)
if [ -z "$OIDC_TOKEN" ] && [ -z "$SYNC_SECRET" ]; then
  echo "::error::No credential available — neither a GitHub OIDC token nor CRON_SECRET/WOODCORE_SYNC_SECRET."
  echo "OIDC needs 'permissions: id-token: write' (set on this job). If that is present and this"
  echo "still fires, the token request itself failed — check the step log above."
  echo "Otherwise set CRON_SECRET in Settings → Secrets and variables → Actions."
  exit 1
fi

if [ -n "$OIDC_TOKEN" ] && [ -n "$SYNC_SECRET" ]; then
  echo "Authenticating with: GitHub OIDC (secret header also sent, as fallback: $SECRET_SOURCE)"
elif [ -n "$OIDC_TOKEN" ]; then
  echo "Authenticating with: GitHub OIDC only (no shared secret configured — the end state)"
else
  echo "Authenticating with: $SECRET_SOURCE (no OIDC token available)"
fi

# ── Start the sync ──────────────────────────────────────────────────────────
posted_at=$(date -u +%s)
code=$(call_sync POST)
echo "POST HTTP $code"
# The start time of the run this job reports on, as the server wrote it.
target=""
case "$code" in
  202)
    echo "Sync started. Waiting for its result." ;;
  409)
    # Already running: report on THAT run. Its result is the mirror's state,
    # and a green job here used to say nothing about it.
    target=$(jq -r '.state.startedAt // empty' "$response" 2>/dev/null || true)
    echo "A sync was already running (started ${target:-at an unknown time}). Waiting for its result instead." ;;
  403)
    echo "::error::403 forbidden — the secret this workflow sent ($SECRET_SOURCE) no longer matches the server's CRON_SECRET."
    echo "This is the expected symptom after a secret rotation: CRON_SECRET (or JWT_SECRET,"
    echo "which it falls back to) was changed on Railway without updating this repository secret."
    echo "It happened on 2026-08-02 and the mirror went stale for three days before anyone noticed."
    echo
    echo "Fix: copy the CURRENT CRON_SECRET from Railway into"
    echo "  GitHub → Settings → Secrets and variables → Actions → $SECRET_SOURCE"
    if [ "$SECRET_SOURCE" = "CRON_SECRET" ]; then
      echo
      echo "Note: WOODCORE_SYNC_SECRET is IGNORED while CRON_SECRET exists — editing it"
      echo "will not clear this error. Once CRON_SECRET is confirmed working, delete the"
      echo "legacy secret so there is only one value left to rotate."
    fi
    echo
    echo "Then re-run this workflow. The server logs the same diagnosis under [syncAuth]."
    echo "Rotation runbook: CLAUDE.md §18 — it lists every consumer that must be updated together."
    exit 1 ;;
  *)
    echo "::error::Unexpected status $code from $SYNC_URL$(error_field)"
    exit 1 ;;
esac

# ── Wait for that run to finish ─────────────────────────────────────────────
deadline=$(( $(date -u +%s) + DEADLINE_SECONDS ))
failures=0
lost=0
while :; do
  if [ "$(date -u +%s)" -ge "$deadline" ]; then
    echo "::error::The sync was still running after $(( DEADLINE_SECONDS / 60 )) minutes, so its result is unknown."
    echo "It keeps running on the server. Check GET /api/woodcore/sync, or the server log under [woodcoreSync]."
    exit 1
  fi
  sleep "$POLL_INTERVAL_SECONDS"

  code=$(call_sync GET)
  if [ "$code" != "200" ] || ! jq -e 'type == "object"' "$response" >/dev/null 2>&1; then
    failures=$(( failures + 1 ))
    echo "Status check: HTTP $code ($failures of $STATUS_FAILURE_POLLS failures allowed in a row)"
    if [ "$failures" -ge "$STATUS_FAILURE_POLLS" ]; then
      echo "::error::GET $SYNC_URL stopped answering (last: HTTP $code$(error_field)), so the sync's result is unknown."
      if [ "$code" = "403" ]; then
        echo "403 is a credential refusal. The POST was accepted, so the credential changed mid-run."
        echo "Rotation runbook: CLAUDE.md §18."
      fi
      exit 1
    fi
    continue
  fi
  failures=0

  started=$(jq -r '.startedAt // empty' "$response")
  # A 202's run is the first one seen that started after the POST was sent.
  if [ -z "$target" ] && [ -n "$started" ]; then
    started_epoch=$(epoch "$started")
    if [ -n "$started_epoch" ] && [ "$started_epoch" -ge $(( posted_at - CLOCK_SKEW_SECONDS )) ]; then
      target=$started
    fi
  fi
  if [ -z "$target" ] || [ "$started" != "$target" ]; then
    lost=$(( lost + 1 ))
    echo "The server is not showing this job's run; it shows a run started ${started:-never} ($lost of $LOST_RUN_POLLS)."
    if [ "$lost" -ge "$LOST_RUN_POLLS" ]; then
      echo "::error::The run this job is waiting for is no longer visible on the server, so its result is unknown."
      echo "A restart or deploy during a sync loses it, and its tables may be partly refreshed. Re-run this workflow."
      exit 1
    fi
    continue
  fi
  lost=0

  if [ "$(jq -r '.running' "$response")" = "true" ]; then
    jq -r '"Running: \([.tables[]?.copied // 0] | add // 0) rows copied so far."' "$response"
    continue
  fi
  break
done

# ── Judge the finished run ──────────────────────────────────────────────────
# A reason is printed only in the code-only form errorSummary gives a database
# error. Anything else (a connection message, say) can carry a host name.
SHOWN='def shown: if test("^database error( \\([A-Z0-9_]+\\))?$") then . else "reason withheld from this public log; see the server log" end;'

echo
echo "Sync finished at $(jq -r '.finishedAt // "an unknown time"' "$response"), after $(jq -r '((.durationMs // 0) / 1000 | floor)' "$response")s:"
jq -r "$SHOWN"' .tables[]? | "  \(.mirror): \(.status), \(.copied // 0) rows" + (if (.reason | type) == "string" then " (\(.reason | shown))" else "" end)' "$response"

fatal=$(jq -r "$SHOWN"' if (.error | type) == "string" then (.error | shown) else empty end' "$response")
failed=$(jq -r '[.tables[]? | select(.status == "error") | .mirror] | join(", ")' "$response")
skipped=$(jq -r '[.tables[]? | select(.status == "skipped") | .mirror] | join(", ")' "$response")
tables=$(jq -r '[.tables[]?] | length' "$response")
finished=$(jq -r '.finishedAt // empty' "$response")

verdict=0
if [ -n "$skipped" ]; then
  echo "::warning::Skipped, and kept their previous data: $skipped."
fi
if [ -n "$fatal" ]; then
  echo "::error::The sync stopped: $fatal."
  verdict=1
fi
if [ -n "$failed" ]; then
  echo "::error::These mirror tables failed to refresh: $failed. Their reasons are listed above."
  verdict=1
fi
if [ "$tables" -eq 0 ]; then
  echo "::error::The sync finished without reporting any table."
  verdict=1
fi
if [ -z "$finished" ]; then
  echo "::error::The sync stopped without a finish time."
  verdict=1
fi
if [ "$verdict" -eq 0 ]; then
  echo "Woodcore mirror refreshed."
fi
exit "$verdict"
