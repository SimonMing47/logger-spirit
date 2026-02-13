#!/usr/bin/env bash
set -euo pipefail
export COPYFILE_DISABLE=1

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$ROOT_DIR/sample-data/generated"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/logger-spirit-sample.XXXXXX")"

cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

mkdir -p "$OUT_DIR"
# Only delete artifacts managed by this script.
rm -f \
  "$OUT_DIR/incident-alpha-2026-02-12.zip" \
  "$OUT_DIR/incident-beta-2026-02-12.zip" \
  "$OUT_DIR/incident-gamma-2026-02-13-nested-gz.zip" \
  "$OUT_DIR/search-hints.json"

write_checkout_pod() {
  local target_zip="$1"
  local pod_dir="$WORK_DIR/checkout-pod"
  mkdir -p "$pod_dir/logs" "$pod_dir/archives"

  cat > "$pod_dir/logs/app.log" <<'LOG'
2026-02-12T09:13:58.102Z INFO  [checkout] pod=checkout-7f9d-9q2 service=checkout-api traceId=alpha-trace-0001 requestId=req-81 start checkout flow
2026-02-12T09:14:10.904Z WARN  [checkout] traceId=alpha-trace-0001 cartId=C-7783 inventory check slow elapsedMs=933
2026-02-12T09:14:23.220Z ERROR [checkout] traceId=alpha-trace-0001 code=PAYMENT_TIMEOUT message="payment gateway timeout after 3000ms" podIP=10.22.14.39
2026-02-12T09:14:24.011Z INFO  [checkout] traceId=alpha-trace-0001 fallback=retry-policy retry=1
2026-02-12T09:14:25.441Z INFO  [checkout] traceId=alpha-trace-0001 result=FAILED userId=u-9938
LOG

  cat > "$pod_dir/logs/nginx-access.log" <<'LOG'
10.9.2.18 - - [12/Feb/2026:09:14:23 +0000] "POST /api/v1/checkout HTTP/1.1" 504 128 "-" "gateway/2.3" request_time=3.013 upstream_response_time=3.001 traceId=alpha-trace-0001
10.9.2.18 - - [12/Feb/2026:09:14:25 +0000] "POST /api/v1/checkout HTTP/1.1" 500 93 "-" "gateway/2.3" request_time=1.121 upstream_response_time=1.110 traceId=alpha-trace-0001
LOG

  local trace_stage="$WORK_DIR/checkout-trace-stage"
  mkdir -p "$trace_stage/trace-stack" "$trace_stage/layer2-data"

  cat > "$trace_stage/trace-stack/trace-level-1.log" <<'LOG'
2026-02-12T09:14:23.225Z span=checkout.submit_order traceId=alpha-trace-0001 status=error error=PAYMENT_TIMEOUT
2026-02-12T09:14:23.229Z span=checkout.call_payment traceId=alpha-trace-0001 remote=payment-svc:8443
LOG

  cat > "$trace_stage/layer2-data/trace-level-2.log" <<'LOG'
2026-02-12T09:14:23.232Z deepLayer=true traceId=alpha-trace-0001 event=socket_connect state=timeout
2026-02-12T09:14:23.235Z deepLayer=true traceId=alpha-trace-0001 event=retry_backoff durationMs=150
LOG

  (
    cd "$trace_stage"
    zip -X -q -r "nested-layer.zip" "layer2-data"
    zip -X -q -r "$pod_dir/archives/trace-bundle.zip" "trace-stack" "nested-layer.zip"
  )

  local sidecar_stage="$WORK_DIR/checkout-sidecar-stage"
  mkdir -p "$sidecar_stage/metrics"

  cat > "$sidecar_stage/metrics/otel.log" <<'LOG'
2026-02-12T09:14:20.500Z INFO  exporter=otlp queue=spans sent=882 failed=0
2026-02-12T09:14:23.240Z WARN  exporter=otlp queue=spans dropped=120 reason=backpressure service=checkout
LOG

  cat > "$sidecar_stage/metrics/prometheus.log" <<'LOG'
2026-02-12T09:14:23.300Z scrape=checkout pod=checkout-7f9d-9q2 metric=http_server_errors_total value=17
LOG

  tar -czf "$pod_dir/archives/sidecar-metrics.tar.gz" -C "$sidecar_stage" "metrics"

  (
    cd "$pod_dir"
    zip -X -q -r "$target_zip" .
  )
}

write_payment_pod() {
  local target_zip="$1"
  local pod_dir="$WORK_DIR/payment-pod"
  mkdir -p "$pod_dir/logs" "$pod_dir/archives"

  cat > "$pod_dir/logs/payment.log" <<'LOG'
2026-02-12T09:14:22.901Z INFO  [payment] pod=payment-4ac1-z88 traceId=alpha-trace-0001 begin auth
2026-02-12T09:14:23.219Z ERROR [payment] traceId=alpha-trace-0001 code=DB_CONN_REFUSED message="dial tcp 10.31.8.17:5432: connect: connection refused"
2026-02-12T09:14:24.001Z WARN  [payment] traceId=alpha-trace-0001 fallback=readonly-cache
LOG

  cat > "$pod_dir/logs/worker.log" <<'LOG'
2026-02-12T09:14:23.500Z WARN  [payment-worker] queue=settlement lag=782 msg=KafkaOffsetLag topic=payment.events partition=2
2026-02-12T09:14:25.000Z INFO  [payment-worker] queue=settlement lag=790
LOG

  local socket_stage="$WORK_DIR/payment-socket-stage"
  mkdir -p "$socket_stage/socket"

  cat > "$socket_stage/socket/net-dump.log" <<'LOG'
2026-02-12T09:14:23.223Z src=payment-4ac1-z88 dst=postgres-0.default.svc:5432 connect=failed errno=111
LOG

  (
    cd "$socket_stage"
    zip -X -q -r "socket-dump.zip" "socket"
  )

  local forensic_stage="$WORK_DIR/payment-forensic-stage"
  mkdir -p "$forensic_stage/forensics"
  mv "$socket_stage/socket-dump.zip" "$forensic_stage/forensics/socket-dump.zip"

  cat > "$forensic_stage/forensics/summary.log" <<'LOG'
2026-02-12T09:14:23.230Z forensic=payment traceId=alpha-trace-0001 problem=DB_CONN_REFUSED
LOG

  tar -czf "$pod_dir/archives/forensics.tar.gz" -C "$forensic_stage" "forensics"

  (
    cd "$pod_dir"
    zip -X -q -r "$target_zip" .
  )
}

write_order_pod() {
  local target_zip="$1"
  local pod_dir="$WORK_DIR/order-pod"
  mkdir -p "$pod_dir/logs" "$pod_dir/archives"

  cat > "$pod_dir/logs/order.log" <<'LOG'
2026-02-12T10:01:01.010Z INFO  [order] pod=order-a91-1px traceId=beta-trace-1002 createOrder start
2026-02-12T10:01:04.882Z ERROR [order] traceId=beta-trace-1002 code=INVENTORY_STALE message="inventory snapshot expired"
2026-02-12T10:01:05.500Z INFO  [order] traceId=beta-trace-1002 rollback complete
LOG

  cat > "$pod_dir/logs/grpc.log" <<'LOG'
2026-02-12T10:01:04.101Z WARN  grpc_client=inventory timeoutMs=1200 method=ReserveItems traceId=beta-trace-1002
2026-02-12T10:01:04.871Z ERROR grpc_client=inventory rpc=Unavailable desc="upstream reset" traceId=beta-trace-1002
LOG

  local deep_tar_stage="$WORK_DIR/order-deep-tar-stage"
  mkdir -p "$deep_tar_stage/deep"
  cat > "$deep_tar_stage/deep/timeline.log" <<'LOG'
2026-02-12T10:01:04.900Z phase=reserve-items traceId=beta-trace-1002 status=failed reason=INVENTORY_STALE
LOG
  tar -czf "$WORK_DIR/order-dump.tar.gz" -C "$deep_tar_stage" "deep"

  local incident_zip_stage="$WORK_DIR/order-incident-zip-stage"
  mkdir -p "$incident_zip_stage/incident"
  mv "$WORK_DIR/order-dump.tar.gz" "$incident_zip_stage/incident/dump.tar.gz"
  cat > "$incident_zip_stage/incident/README.txt" <<'LOG'
This archive contains nested diagnostic dump for order pod.
LOG

  (
    cd "$incident_zip_stage"
    zip -X -q -r "$pod_dir/archives/incident-pack.zip" "incident"
  )

  (
    cd "$pod_dir"
    zip -X -q -r "$target_zip" .
  )
}

write_search_pod() {
  local target_zip="$1"
  local pod_dir="$WORK_DIR/search-pod"
  mkdir -p "$pod_dir/logs" "$pod_dir/archives"

  cat > "$pod_dir/logs/search.log" <<'LOG'
2026-02-12T10:02:12.021Z INFO  [search] pod=search-33cd-f31 traceId=beta-trace-1002 query="order status"
2026-02-12T10:02:13.001Z WARN  [search] traceId=beta-trace-1002 cache=miss durationMs=832
LOG

  cat > "$pod_dir/logs/indexer.log" <<'LOG'
2026-02-12T10:02:13.220Z ERROR [indexer] traceId=beta-trace-1002 code=REDIS_TIMEOUT message="dial tcp 10.2.66.7:6379: i/o timeout"
LOG

  local nested_stage="$WORK_DIR/search-nested-stage"
  mkdir -p "$nested_stage/hotfix"

  cat > "$nested_stage/hotfix/patch.log" <<'LOG'
2026-02-12T10:02:13.300Z hotfix=cache-fallback traceId=beta-trace-1002 applied=true
LOG

  (
    cd "$nested_stage"
    zip -X -q -r "$pod_dir/archives/hotfix.zip" "hotfix"
  )

  (
    cd "$pod_dir"
    zip -X -q -r "$target_zip" .
  )
}

write_checkout_gz_pod() {
  local target_zip="$1"
  local pod_dir="$WORK_DIR/checkout-gz-pod"
  mkdir -p "$pod_dir/logs" "$pod_dir/archives"

  local plain_log="$pod_dir/logs/app.log"
  : > "$plain_log"
  for i in $(seq 1 6000); do
    local sec
    sec="$(printf '%02d' $((i % 60)))"
    local ms
    ms="$(printf '%03d' $((i % 1000)))"
    local level="INFO"
    local msg="checkout ok"
    if (( i % 211 == 0 )); then
      level="ERROR"
      msg="payment gateway timeout"
    elif (( i % 97 == 0 )); then
      level="WARN"
      msg="retry backoff"
    fi
    printf "2026-02-13T09:15:%s.%sZ %-5s namespace=prod pod=checkout-gz-7f9d container=app service=checkout traceId=gamma-trace-0001 spanId=%08x message=\"%s\"\n" \
      "$sec" "$ms" "$level" "$i" "$msg" >> "$plain_log"
  done
  gzip -c "$plain_log" > "$pod_dir/logs/app.log.gz"
  rm -f "$plain_log"

  cat > "$pod_dir/logs/nginx-access.log" <<'LOG'
10.9.2.18 - - [13/Feb/2026:09:15:23 +0000] "POST /api/v1/checkout HTTP/1.1" 504 128 "-" "gateway/2.3" request_time=3.013 upstream_response_time=3.001 traceId=gamma-trace-0001
LOG

  # Build a multi-layer nested zip that eventually contains .log.gz and a .zip.gz wrapper.
  local deep_stage="$WORK_DIR/checkout-gz-deep-stage"
  rm -rf "$deep_stage"
  mkdir -p "$deep_stage/level3/content" "$deep_stage/level2/content" "$deep_stage/level1/content"

  # Level 3 payload: gz logs + a gz JSON file.
  cat > "$deep_stage/level3/content/trace-level-3.log" <<'LOG'
2026-02-13T09:15:23.225Z ERROR traceId=gamma-trace-0001 span=checkout.call_payment code=PAYMENT_TIMEOUT message="timeout after 3000ms"
2026-02-13T09:15:23.229Z WARN  traceId=gamma-trace-0001 span=checkout.retry event=retry_backoff durationMs=150
LOG
  gzip -c "$deep_stage/level3/content/trace-level-3.log" > "$deep_stage/level3/content/trace-level-3.log.gz"
  rm -f "$deep_stage/level3/content/trace-level-3.log"

  cat > "$deep_stage/level3/content/span.json" <<'JSON'
{"traceId":"gamma-trace-0001","spanId":"0000002a","service":"checkout","event":"timeout","ts":"2026-02-13T09:15:23.225Z"}
JSON
  gzip -c "$deep_stage/level3/content/span.json" > "$deep_stage/level3/content/span.json.gz"
  rm -f "$deep_stage/level3/content/span.json"

  (
    cd "$deep_stage/level3"
    zip -X -q -r "level3.zip" "content"
    gzip -c "level3.zip" > "$deep_stage/level2/content/level3.zip.gz"
  )

  # Level 2: include a couple of gz chunks + the level3.zip.gz wrapper.
  printf "2026-02-13T09:15:23.232Z INFO  traceId=gamma-trace-0001 chunk=1 message=\"deep chunk 1\"\n" > "$deep_stage/level2/content/chunk-1.log"
  gzip -c "$deep_stage/level2/content/chunk-1.log" > "$deep_stage/level2/content/chunk-1.log.gz"
  rm -f "$deep_stage/level2/content/chunk-1.log"

  printf "2026-02-13T09:15:23.235Z INFO  traceId=gamma-trace-0001 chunk=2 message=\"deep chunk 2\"\n" > "$deep_stage/level2/content/chunk-2.log"
  gzip -c "$deep_stage/level2/content/chunk-2.log" > "$deep_stage/level2/content/chunk-2.log.gz"
  rm -f "$deep_stage/level2/content/chunk-2.log"

  (
    cd "$deep_stage/level2"
    zip -X -q -r "$deep_stage/level1/content/level2.zip" "content"
  )

  printf "Nested archive chain: level1.zip -> level2.zip -> level3.zip.gz -> level3.zip -> *.log.gz/*.json.gz\n" > "$deep_stage/level1/content/README.txt"
  (
    cd "$deep_stage/level1"
    zip -X -q -r "$pod_dir/archives/nested-level1.zip" "content"
  )

  (
    cd "$pod_dir"
    zip -X -q -r "$target_zip" .
  )
}

write_payment_gz_pod() {
  local target_zip="$1"
  local pod_dir="$WORK_DIR/payment-gz-pod"
  mkdir -p "$pod_dir/logs" "$pod_dir/archives"

  local plain_log="$pod_dir/logs/payment.log"
  : > "$plain_log"
  for i in $(seq 1 4000); do
    local sec
    sec="$(printf '%02d' $((i % 60)))"
    local ms
    ms="$(printf '%03d' $((i % 1000)))"
    local level="INFO"
    local msg="auth ok"
    if (( i % 173 == 0 )); then
      level="ERROR"
      msg="dial tcp 10.31.8.17:5432: connect: connection refused"
    elif (( i % 83 == 0 )); then
      level="WARN"
      msg="retry storm detected"
    fi
    printf "2026-02-13T09:16:%s.%sZ %-5s namespace=prod pod=payment-gz-4ac1 container=app service=payment traceId=gamma-trace-0001 spanId=%08x message=\"%s\"\n" \
      "$sec" "$ms" "$level" "$i" "$msg" >> "$plain_log"
  done
  gzip -c "$plain_log" > "$pod_dir/logs/payment.log.gz"
  rm -f "$plain_log"

  # A gzip file that is NOT an archive (should become a single decompressed file).
  printf "2026-02-13T09:16:23.999Z INFO  type=diagnostic traceId=gamma-trace-0001 message=\"plain gzip payload\"\n" > "$pod_dir/archives/diag.txt"
  gzip -c "$pod_dir/archives/diag.txt" > "$pod_dir/archives/diag.txt.gz"
  rm -f "$pod_dir/archives/diag.txt"

  (
    cd "$pod_dir"
    zip -X -q -r "$target_zip" .
  )
}

build_alpha_archive() {
  local alpha_root="$WORK_DIR/alpha-root"
  mkdir -p "$alpha_root/namespace-prod" "$alpha_root/cluster"

  write_checkout_pod "$alpha_root/namespace-prod/checkout-pod-7f9d.zip"
  write_payment_pod "$alpha_root/namespace-prod/payment-pod-4ac1.zip"

  local events_stage="$WORK_DIR/alpha-events-stage"
  mkdir -p "$events_stage/events"
  cat > "$events_stage/events/kube-events.log" <<'LOG'
2026-02-12T09:14:20.010Z namespace=prod type=Warning reason=BackOff pod=checkout-7f9d-9q2 message="Back-off restarting failed container"
2026-02-12T09:14:23.980Z namespace=prod type=Warning reason=Unhealthy pod=payment-4ac1-z88 message="Readiness probe failed"
LOG
  tar -czf "$alpha_root/cluster/cluster-events.tar.gz" -C "$events_stage" "events"

  cat > "$alpha_root/README.txt" <<'LOG'
incident-alpha-2026-02-12
contains checkout and payment pod bundles with nested zip and tar.gz archives.
LOG

  (
    cd "$alpha_root"
    zip -X -q -r "$OUT_DIR/incident-alpha-2026-02-12.zip" .
  )
}

build_beta_archive() {
  local beta_root="$WORK_DIR/beta-root"
  mkdir -p "$beta_root/namespace-staging" "$beta_root/support"

  write_order_pod "$beta_root/namespace-staging/order-pod-a91.zip"
  write_search_pod "$beta_root/namespace-staging/search-pod-33cd.zip"

  local support_stage="$WORK_DIR/beta-support-stage"
  mkdir -p "$support_stage/support"
  cat > "$support_stage/support/ticket-notes.log" <<'LOG'
2026-02-12T10:04:00.001Z ticket=SUP-1993 summary="staging order flow intermittent failures"
LOG
  tar -czf "$beta_root/support/ops-notes.tar.gz" -C "$support_stage" "support"

  (
    cd "$beta_root"
    zip -X -q -r "$OUT_DIR/incident-beta-2026-02-12.zip" .
  )
}

build_gamma_archive() {
  local gamma_root="$WORK_DIR/gamma-root"
  mkdir -p "$gamma_root/namespace-prod" "$gamma_root/cluster"

  write_checkout_gz_pod "$gamma_root/namespace-prod/checkout-pod-gz.zip"
  write_payment_gz_pod "$gamma_root/namespace-prod/payment-pod-gz.zip"

  # Cluster-wide events as plain .gz (single-file gzip).
  local events_dir="$WORK_DIR/gamma-events-stage"
  rm -rf "$events_dir"
  mkdir -p "$events_dir"
  cat > "$events_dir/kube-events.log" <<'LOG'
2026-02-13T09:15:20.010Z namespace=prod type=Warning reason=BackOff pod=checkout-gz-7f9d message="Back-off restarting failed container"
2026-02-13T09:16:23.980Z namespace=prod type=Warning reason=Unhealthy pod=payment-gz-4ac1 message="Readiness probe failed"
LOG
  gzip -c "$events_dir/kube-events.log" > "$gamma_root/cluster/kube-events.log.gz"

  cat > "$gamma_root/README.txt" <<'LOG'
incident-gamma-2026-02-13-nested-gz
This sample includes nested zip -> zip -> zip.gz -> zip -> *.log.gz/*.json.gz and plain *.log.gz files.
Use it to verify recursive extraction of nested zip + gzip single-file payloads.
LOG

  (
    cd "$gamma_root"
    zip -X -q -r "$OUT_DIR/incident-gamma-2026-02-13-nested-gz.zip" .
  )
}

build_alpha_archive
build_beta_archive
build_gamma_archive

cat > "$OUT_DIR/search-hints.json" <<'JSON'
{
  "queries": [
    "PAYMENT_TIMEOUT",
    "DB_CONN_REFUSED",
    "retry storm",
    "KafkaOffsetLag",
    "INVENTORY_STALE",
    "REDIS_TIMEOUT",
    "beta-trace-1002",
    "alpha-trace-0001",
    "gamma-trace-0001"
  ],
  "archives": [
    "incident-alpha-2026-02-12.zip",
    "incident-beta-2026-02-12.zip",
    "incident-gamma-2026-02-13-nested-gz.zip"
  ]
}
JSON

echo "Generated archives:"
ls -lh "$OUT_DIR"/*.zip

echo
echo "Hints: $OUT_DIR/search-hints.json"
