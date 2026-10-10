#!/usr/bin/env bash
#
# Start the throwaway MySQL the Tests job runs against.
#
# This exists because a `services:` container is pulled BEFORE any step runs, so
# a registry blip fails the job outright and no step of ours can retry it.
# GitHub's own retry is three attempts over about a minute, which is not enough
# for an outage measured in minutes:
#
#   run 37995168085, 2026-10-09 — Tests failed without executing one test
#     Head "https://registry-1.docker.io/v2/library/mysql/manifests/8.0":
#     Get "https://auth.docker.io/token?account=githubactions&..."
#     net/http: request canceled (Client.Timeout exceeded while awaiting headers)
#   ... ×3, then: ##[error]Docker pull failed with exit code 1
#
# Note `account=githubactions`: that is the runner's own Docker Hub arrangement,
# and the failure is reaching `auth.docker.io` at all. So this is NOT the
# anonymous pull-rate limit, and adding our own Docker Hub credentials would not
# have helped — the token request goes to the same endpoint either way. What
# helps is waiting longer and trying again, which is all this script does.
#
# The image stays `mysql:8.0` deliberately. The runner ships a MySQL of its own,
# which would remove the registry dependency completely, but its version follows
# the runner image rather than this file — and CI being real MySQL 8.0 is what
# makes the migration-portability check meaningful (a TiDB-only
# `CREATE INDEX IF NOT EXISTS` must fail here, which is server/
# migrationIntegrity.test.ts's whole purpose). A pinned image is worth one
# retry loop.
set -euo pipefail

IMAGE="${MYSQL_IMAGE:-mysql:8.0}"
CONTAINER="${MYSQL_CONTAINER:-reconcileai-test-mysql}"
ROOT_PASSWORD="${MYSQL_ROOT_PASSWORD:-root}"
DATABASE="${MYSQL_DATABASE:-reconcileai_test}"

# Five attempts with growing backoff: ~2.5 minutes of waiting on top of the
# pulls themselves, against GitHub's ~1 minute.
PULL_ATTEMPTS="${MYSQL_PULL_ATTEMPTS:-5}"
PULL_BACKOFF_SECONDS="${MYSQL_PULL_BACKOFF_SECONDS:-15}"
# Readiness: MySQL's first-run initialisation is the slow part, not the start.
READY_ATTEMPTS="${MYSQL_READY_ATTEMPTS:-90}"
READY_INTERVAL_SECONDS="${MYSQL_READY_INTERVAL_SECONDS:-2}"

log() { printf '%s %s\n' "[start-test-mysql]" "$*"; }

pull_image() {
  local attempt
  for ((attempt = 1; attempt <= PULL_ATTEMPTS; attempt++)); do
    if docker pull "$IMAGE"; then
      log "pulled $IMAGE on attempt $attempt"
      return 0
    fi
    if ((attempt == PULL_ATTEMPTS)); then break; fi
    local backoff=$((attempt * PULL_BACKOFF_SECONDS))
    log "pull attempt $attempt of $PULL_ATTEMPTS failed; retrying in ${backoff}s"
    sleep "$backoff"
  done
  log "could not pull $IMAGE after $PULL_ATTEMPTS attempts"
  return 1
}

wait_until_ready() {
  local attempt
  for ((attempt = 1; attempt <= READY_ATTEMPTS; attempt++)); do
    if docker exec "$CONTAINER" \
      mysqladmin ping -h 127.0.0.1 -uroot -p"$ROOT_PASSWORD" --silent >/dev/null 2>&1; then
      log "MySQL answered after $((attempt * READY_INTERVAL_SECONDS))s"
      return 0
    fi
    # A container that has exited will never answer; say so rather than
    # spending the whole window on it.
    if [[ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" != "true" ]]; then
      log "container is no longer running; its log follows"
      docker logs "$CONTAINER" || true
      return 1
    fi
    sleep "$READY_INTERVAL_SECONDS"
  done
  log "MySQL did not become ready; its log follows"
  docker logs "$CONTAINER" || true
  return 1
}

pull_image

log "starting $CONTAINER"
docker run --detach \
  --name "$CONTAINER" \
  --env MYSQL_ROOT_PASSWORD="$ROOT_PASSWORD" \
  --env MYSQL_DATABASE="$DATABASE" \
  --publish 3306:3306 \
  "$IMAGE" >/dev/null

wait_until_ready
log "ready on 127.0.0.1:3306, database $DATABASE"
