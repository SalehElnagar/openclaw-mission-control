#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  render_env_from_key_vault.sh <key-vault-name> <public-hostname> <output-env-file>

Example:
  render_env_from_key_vault.sh kv-eus2-ai-ocw-rt-dev01 advancedclaw.example.com /etc/advancedclaw/mission-control.env

Notes:
  - Uses managed identity (`az login --identity`) when no active Azure CLI session exists.
  - Writes strict-permission env file (0600).
  - Never prints secret values.
EOF
}

if [ "$#" -ne 3 ]; then
  usage
  exit 1
fi

for cmd in az jq; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
done

key_vault_name="$1"
public_host="$2"
output_file="$3"

local_auth_secret_name="${MC_SECRET_LOCAL_AUTH_NAME:-mc-local-auth-token}"
postgres_secret_name="${MC_SECRET_POSTGRES_PASSWORD_NAME:-mc-postgres-password}"

frontend_port="${MC_FRONTEND_PORT:-13000}"
backend_port="${MC_BACKEND_PORT:-18000}"

if ! az account show >/dev/null 2>&1; then
  az login --identity >/dev/null
fi

kv_secret() {
  local name="$1"
  az keyvault secret show \
    --vault-name "$key_vault_name" \
    --name "$name" \
    --query value \
    --output tsv
}

local_auth_token="$(kv_secret "$local_auth_secret_name")"
postgres_password="$(kv_secret "$postgres_secret_name")"

if [ -z "$local_auth_token" ] || [ -z "$postgres_password" ]; then
  echo "One or more required secrets are empty." >&2
  exit 1
fi

install -d -m 0750 "$(dirname "$output_file")"
umask 077

cat > "$output_file" <<EOF
AUTH_MODE=local
LOCAL_AUTH_TOKEN=$local_auth_token
POSTGRES_DB=mission_control
POSTGRES_USER=postgres
POSTGRES_PASSWORD=$postgres_password
POSTGRES_PORT=5432
REDIS_PORT=6379
FRONTEND_PORT=$frontend_port
BACKEND_PORT=$backend_port
BASE_URL=https://$public_host
NEXT_PUBLIC_API_URL=https://$public_host
CORS_ORIGINS=https://$public_host
DB_AUTO_MIGRATE=true
LOG_LEVEL=INFO
REQUEST_LOG_SLOW_MS=1000
EOF

chmod 600 "$output_file"
echo "Wrote runtime env file to $output_file"
