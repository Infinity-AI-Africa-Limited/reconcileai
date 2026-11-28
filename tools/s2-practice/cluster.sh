#!/usr/bin/env bash
# Synthetic S2 practice cluster: made-up data only, never production.
#
#   cluster.sh up   <workdir>   start PD + TiKV + a TiDB source, and a TiDB target
#   cluster.sh down <workdir>   remove every container, the network and the workdir
#
# The source is a real distributed TiDB (PD + TiKV), because Starter is one:
# snapshot reads, start_ts and the CLUSTER_* tables behave as they do there.
# The target is a standalone TiDB of the same version. Both serve TLS with a
# throwaway CA made here, so the client profile's VERIFY_IDENTITY is exercised.
# Ports are published on 127.0.0.1 only. That limits who connects in, not what
# the containers reach out to: this is not an isolated environment, so it is
# for made-up data and throwaway credentials only.
set -euo pipefail

ACTION="${1:?usage: cluster.sh up|down <workdir>}"
WORK="${2:?usage: cluster.sh up|down <workdir>}"
TIDB_VERSION="${S2_TIDB_VERSION:-v8.5.8}"
REGISTRY="${S2_REGISTRY:-mirror.gcr.io}"
NET=s2net
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
CONTAINERS=(s2-source s2-target s2-tikv s2-pd)

down() {
  for c in "${CONTAINERS[@]}"; do docker rm -f "$c" >/dev/null 2>&1 || true; done
  docker network rm "$NET" >/dev/null 2>&1 || true
  # The workdir holds synthetic dumps and a throwaway CA; remove it.
  if [ -d "$WORK" ]; then rm -rf "$WORK"; fi
}

certs() {
  local d="$WORK/certs"
  mkdir -p "$d"
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=s2-practice-ca" \
    -keyout "$d/ca-key.pem" -out "$d/ca.pem" 2>/dev/null
  openssl req -newkey rsa:2048 -nodes -subj "/CN=s2-source" \
    -keyout "$d/server-key.pem" -out "$d/server.csr" 2>/dev/null
  printf 'subjectAltName=DNS:s2-source,DNS:s2-target\nextendedKeyUsage=serverAuth\n' > "$d/ext.cnf"
  openssl x509 -req -in "$d/server.csr" -CA "$d/ca.pem" -CAkey "$d/ca-key.pem" -CAcreateserial \
    -days 2 -extfile "$d/ext.cnf" -out "$d/server.pem" 2>/dev/null
  rm -f "$d/ca-key.pem" "$d/server.csr" "$d/ext.cnf" "$d/ca.srl"
  chmod 0644 "$d"/*.pem
}

wait_sql() {
  local port="$1" name="$2"
  for _ in $(seq 1 120); do
    if docker exec "$name" sh -c 'exit 0' >/dev/null 2>&1 && \
       (cd "$REPO" && node -e "require('mysql2/promise').createConnection({host:'127.0.0.1',port:$port,user:'root'}).then(c=>c.end()).then(()=>process.exit(0),()=>process.exit(1))" 2>/dev/null); then
      return 0
    fi
    sleep 2
  done
  echo "timed out waiting for $name" >&2
  docker logs --tail 40 "$name" >&2 || true
  return 1
}

up() {
  down
  mkdir -p "$WORK/conf" "$WORK/dumps"
  certs
  cat > "$WORK/conf/tidb.toml" <<'TOML'
[security]
ssl-ca = "/certs/ca.pem"
ssl-cert = "/certs/server.pem"
ssl-key = "/certs/server-key.pem"
TOML
  # TiKV refuses to start unless the open-file limit covers its RocksDB budget
  # (about 124k at the defaults). Sandboxes and CI runners cap it lower, so the
  # budget is cut instead. It changes nothing this practice measures.
  cat > "$WORK/conf/tikv.toml" <<'TOML'
[rocksdb]
max-open-files = 4096
[raftdb]
max-open-files = 4096
TOML
  docker network create "$NET" >/dev/null
  docker run -d --name s2-pd --network "$NET" "$REGISTRY/pingcap/pd:$TIDB_VERSION" \
    --name=pd --data-dir=/data/pd \
    --client-urls=http://0.0.0.0:2379 --advertise-client-urls=http://s2-pd:2379 \
    --peer-urls=http://0.0.0.0:2380 --advertise-peer-urls=http://s2-pd:2380 \
    --initial-cluster=pd=http://s2-pd:2380 >/dev/null
  docker run -d --name s2-tikv --network "$NET" --ulimit "nofile=${S2_TIKV_NOFILE:-20000}:${S2_TIKV_NOFILE:-20000}" \
    -v "$WORK/conf:/conf:ro" "$REGISTRY/pingcap/tikv:$TIDB_VERSION" \
    --addr=0.0.0.0:20160 --advertise-addr=s2-tikv:20160 --status-addr=0.0.0.0:20180 \
    --pd=s2-pd:2379 --data-dir=/data/tikv --config=/conf/tikv.toml >/dev/null
  docker run -d --name s2-source --network "$NET" -p 127.0.0.1:4000:4000 \
    -v "$WORK/certs:/certs:ro" -v "$WORK/conf:/conf:ro" \
    "$REGISTRY/pingcap/tidb:$TIDB_VERSION" \
    --store=tikv --path=s2-pd:2379 --advertise-address=s2-source --config=/conf/tidb.toml >/dev/null
  docker run -d --name s2-target --network "$NET" -p 127.0.0.1:4001:4000 \
    -v "$WORK/certs:/certs:ro" -v "$WORK/conf:/conf:ro" \
    "$REGISTRY/pingcap/tidb:$TIDB_VERSION" \
    --store=unistore --path=/tmp/tidb --advertise-address=s2-target --config=/conf/tidb.toml >/dev/null
  wait_sql 4000 s2-source
  wait_sql 4001 s2-target
  echo "cluster up: TiDB $TIDB_VERSION source 127.0.0.1:4000 (PD+TiKV), target 127.0.0.1:4001"
}

case "$ACTION" in
  up) up ;;
  down) down ;;
  *) echo "unknown action: $ACTION" >&2; exit 2 ;;
esac
