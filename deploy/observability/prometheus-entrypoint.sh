#!/bin/sh
# Renders the scrape config (bearer token only when METRICS_TOKEN is set), then runs Prometheus.
set -eu
if [ -n "${METRICS_TOKEN:-}" ]; then
  umask 077
  printf '%s' "$METRICS_TOKEN" > /tmp/metrics-token
  sed 's/^    #auth /    /' /etc/prometheus/prometheus.yml > /tmp/prometheus.yml
else
  cp /etc/prometheus/prometheus.yml /tmp/prometheus.yml
fi
exec /bin/prometheus \
  --config.file=/tmp/prometheus.yml \
  --storage.tsdb.path=/prometheus \
  --storage.tsdb.retention.time="${PROMETHEUS_RETENTION:-15d}"
