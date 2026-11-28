#!/usr/bin/env bash
#
# Railpack build rehearsal: the runtime half.
#
# Called by .github/workflows/railpack-rehearsal.yml once the image is built. It
# runs the image the way a platform runs a deployment of it, against a
# throwaway MySQL, on a Docker network with no route out:
#
#   pnpm-check        record which pnpm the image runs, and whether running it
#                     needs the npm registry. An observation, never a failure.
#   pnpm-seed         run pnpm once, with normal network access and no app
#                     code, so that any copy of pnpm it fetches lands in the
#                     volume PNPM_TOOLS_VOLUME. On Railway the container has
#                     the internet and fetches it itself; here the app never
#                     does, so the fetch happens once, outside the app.
#   migrate           the pre-deploy command, `pnpm db:migrate`, twice. The
#                     first run must record every committed migration; the
#                     second must add none, as on every later deploy.
#   start NAME [CMD]  start the image with its own start command (or CMD) and
#                     wait for /api/healthz to answer 200. The probe runs in a
#                     separate container on the same network, as a platform
#                     health check reaches a deployment from outside it.
#   stop NAME         send SIGTERM and record how the container ended. This is
#                     an observation, not a gate: see the workflow.
#
# When PNPM_TOOLS_VOLUME is set, migrate and start mount that volume where pnpm
# keeps the versions it fetches, so they find the copy pnpm-seed fetched.
#
# Every value is synthetic. The app receives PORT, DATABASE_URL (the throwaway
# database) and a JWT_SECRET generated here, and nothing else.
set -euo pipefail

: "${IMAGE:?}" "${NETWORK:?}" "${MYSQL_CONTAINER:?}" "${MYSQL_DATABASE:?}" "${MYSQL_ROOT_PASSWORD:?}" "${RESULTS:?}"

# The health-check allowance production's railway.json gives a deployment.
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-120}"
PROBE_INTERVAL_SECONDS="${PROBE_INTERVAL_SECONDS:-2}"
STOP_TIMEOUT_SECONDS="${STOP_TIMEOUT_SECONDS:-30}"
JOURNAL="${JOURNAL:-drizzle/meta/_journal.json}"
PNPM_TOOLS_VOLUME="${PNPM_TOOLS_VOLUME:-}"
APP_PORT=3000
DATABASE_URL_IN_NETWORK="mysql://root:${MYSQL_ROOT_PASSWORD}@${MYSQL_CONTAINER}:3306/${MYSQL_DATABASE}"
# A command that makes pnpm settle its own version, and runs no app code.
PNPM_NOOP="pnpm exec node --version"

log() { printf '[railpack-rehearsal] %s\n' "$*"; }
fail() { printf '::error::%s\n' "$*"; exit 1; }
record() { printf '%s=%s\n' "$1" "$2" >> "$RESULTS"; }

# The --volume arguments for the fetched-pnpm volume, when one is in use. It is
# mounted where pnpm keeps the versions it fetches: $PNPM_HOME/.tools.
TOOLS_MOUNT=()
prepare_tools_mount() {
  TOOLS_MOUNT=()
  if [ -n "$PNPM_TOOLS_VOLUME" ]; then
    local home
    home=$(docker run --rm --network "$NETWORK" --entrypoint printenv "$IMAGE" PNPM_HOME) || home=""
    [ -n "$home" ] || fail "the image sets no PNPM_HOME"
    TOOLS_MOUNT=(--volume "${PNPM_TOOLS_VOLUME}:${home}/.tools")
  fi
}

pnpm_check() {
  local path project_version out status needs
  path=$(docker run --rm --network "$NETWORK" "$IMAGE" "command -v pnpm") || path="none"
  project_version=$(docker run --rm --network "$NETWORK" --entrypoint node "$IMAGE" \
    -p "require('/app/node_modules/pnpm/package.json').version" 2>/dev/null) || project_version="none"
  status=0
  out=$(docker run --rm --network "$NETWORK" "$IMAGE" "$PNPM_NOOP" 2>&1) || status=$?
  if [ "$status" -eq 0 ]; then
    needs=no
  elif grep -q 'registry.npmjs.org' <<<"$out"; then
    needs=yes
  else
    needs=unclear
    log "pnpm failed without network for another reason; its output follows"
    printf '%s\n' "$out"
  fi
  record runtime_pnpm_path "$path"
  record project_pnpm_version "$project_version"
  record runtime_pnpm_needs_registry "$needs"
  log "pnpm on the image's PATH: $path (the project's own pnpm is $project_version)"
  if [ "$needs" = yes ]; then
    printf '::warning::%s\n' "Running pnpm in this image fetches another pnpm from the npm registry first, so every pnpm command at deploy or start time depends on the registry being reachable."
  fi
}

pnpm_seed() {
  [ -n "$PNPM_TOOLS_VOLUME" ] || fail "pnpm-seed needs PNPM_TOOLS_VOLUME"
  prepare_tools_mount
  docker volume create "$PNPM_TOOLS_VOLUME" >/dev/null
  # Normal network on purpose: this container runs pnpm and nothing else.
  docker run --rm "${TOOLS_MOUNT[@]}" "$IMAGE" "$PNPM_NOOP"
  record pnpm_seeded yes
  log "pnpm settled its version once, outside the app"
}

recorded_migrations() {
  docker exec -e MYSQL_PWD="$MYSQL_ROOT_PASSWORD" "$MYSQL_CONTAINER" \
    mysql -uroot -N -B -e "SELECT COUNT(*) FROM \`${MYSQL_DATABASE}\`.__drizzle_migrations"
}

migrate() {
  local expected recorded run
  expected=$(jq '.entries | length' "$JOURNAL")
  prepare_tools_mount
  for run in first repeat; do
    log "pre-deploy command, $run run: pnpm db:migrate"
    docker run --rm --network "$NETWORK" "${TOOLS_MOUNT[@]}" --env DATABASE_URL="$DATABASE_URL_IN_NETWORK" \
      "$IMAGE" "pnpm db:migrate"
    recorded=$(recorded_migrations)
    if [ "$recorded" != "$expected" ]; then
      fail "after the $run run the database records $recorded migrations; the committed journal has $expected"
    fi
  done
  record migrations_journal "$expected"
  record migrations_recorded "$recorded"
  log "every committed migration recorded ($recorded of $expected); the repeat run added none"
}

# 0 when /api/healthz on container $1 answers 200.
probe() {
  docker run --rm --network "$NETWORK" --entrypoint node "$IMAGE" -e \
    "fetch('http://$1:${APP_PORT}/api/healthz').then(r => process.exit(r.status === 200 ? 0 : 1), () => process.exit(1))" \
    >/dev/null 2>&1
}

start() {
  local name=${1:?start needs a container name} command=${2:-} jwt started elapsed
  jwt=$(openssl rand -hex 32)
  echo "::add-mask::$jwt"
  prepare_tools_mount
  local args=(
    --detach --name "$name" --network "$NETWORK"
    "${TOOLS_MOUNT[@]}"
    --env PORT="$APP_PORT"
    --env DATABASE_URL="$DATABASE_URL_IN_NETWORK"
    --env JWT_SECRET="$jwt"
    "$IMAGE"
  )
  if [ -n "$command" ]; then args+=("$command"); fi
  # No apostrophe inside ${...}: bash reads it as an opening quote there.
  local launcher=${command:-the start command baked into the image}
  log "starting $name with $launcher"
  docker run "${args[@]}" >/dev/null
  started=$(date +%s)
  until probe "$name"; do
    elapsed=$(( $(date +%s) - started ))
    if [ "$(docker inspect -f '{{.State.Running}}' "$name")" != "true" ]; then
      log "$name stopped before answering; its last log lines follow"
      docker logs --tail 80 "$name" 2>&1 || true
      fail "$name stopped before /api/healthz answered"
    fi
    if [ "$elapsed" -ge "$HEALTH_TIMEOUT_SECONDS" ]; then
      log "$name has not answered; its last log lines follow"
      docker logs --tail 80 "$name" 2>&1 || true
      fail "$name: /api/healthz did not answer 200 within ${HEALTH_TIMEOUT_SECONDS}s"
    fi
    sleep "$PROBE_INTERVAL_SECONDS"
  done
  elapsed=$(( $(date +%s) - started ))
  record "${name}_healthy_after_seconds" "$elapsed"
  log "$name answered 200 on /api/healthz after about ${elapsed}s"
}

stop() {
  local name=${1:?stop needs a container name} started took code status
  started=$(date +%s)
  docker stop --time "$STOP_TIMEOUT_SECONDS" "$name" >/dev/null
  took=$(( $(date +%s) - started ))
  code=$(docker inspect -f '{{.State.ExitCode}}' "$name")
  # The app logs "[shutdown] <status>; scope=..." when its SIGTERM handler ran.
  status=$(docker logs "$name" 2>&1 | grep -m1 -oE '^\[shutdown\] [a-z_]+' | cut -d' ' -f2 || true)
  record "${name}_stop_seconds" "$took"
  record "${name}_exit_code" "$code"
  record "${name}_shutdown_logged" "${status:-none}"
  log "$name: stopped after ${took}s with exit code $code; shutdown log: ${status:-none}"
}

case "${1:-}" in
  pnpm-check) pnpm_check ;;
  pnpm-seed) pnpm_seed ;;
  migrate) migrate ;;
  start) shift; start "$@" ;;
  stop) shift; stop "$@" ;;
  *) fail "usage: $0 pnpm-check | pnpm-seed | migrate | start NAME [COMMAND] | stop NAME" ;;
esac
