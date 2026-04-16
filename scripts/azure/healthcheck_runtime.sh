#!/usr/bin/env bash
set -euo pipefail

install_root="${MC_INSTALL_ROOT:-/opt/advancedclaw/mission-control}"
env_file="${MC_ENV_FILE:-/etc/advancedclaw/mission-control.env}"
backend_url="${MC_BACKEND_HEALTH_URL:-http://127.0.0.1:18000/healthz}"
frontend_url="${MC_FRONTEND_URL:-http://127.0.0.1:13000/}"
compose_files=("-f" "compose.yml")

if [ -f "$install_root/compose.azure.private.yml" ]; then
  compose_files+=("-f" "compose.azure.private.yml")
fi

if [ ! -d "$install_root" ]; then
  echo "Mission Control install root not found: $install_root" >&2
  exit 1
fi

if [ ! -f "$env_file" ]; then
  echo "Mission Control env file not found: $env_file" >&2
  exit 1
fi

curl -fsS "$backend_url" >/dev/null
curl -fsS "$frontend_url" >/dev/null

(
  cd "$install_root"
  docker compose "${compose_files[@]}" --env-file "$env_file" ps
)

if [ -n "${OCW_GATEWAY_URL:-}" ] && [ -n "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
  openclaw gateway health --url "$OCW_GATEWAY_URL" --token "$OPENCLAW_GATEWAY_TOKEN" --timeout 15000 --json >/dev/null
fi

echo "Runtime health checks passed."
