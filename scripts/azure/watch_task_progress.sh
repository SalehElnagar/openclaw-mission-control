#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  watch_task_progress.sh <base-url> <local-auth-token> <task-id> [duration-seconds]

Example:
  watch_task_progress.sh https://advancedclaw.example.com "$LOCAL_AUTH_TOKEN" 6c0f... 900
EOF
}

if [ "$#" -lt 3 ] || [ "$#" -gt 4 ]; then
  usage
  exit 1
fi

base_url="${1%/}"
auth_token="$2"
task_id="$3"
duration="${4:-900}"
end_epoch="$(( $(date +%s) + duration ))"

for cmd in curl jq; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
done

while [ "$(date +%s)" -lt "$end_epoch" ]; do
  response="$(curl -fsS \
    -H "Authorization: Bearer $auth_token" \
    -H "Content-Type: application/json" \
    "$base_url/api/v1/tasks/$task_id")"

  status="$(printf '%s' "$response" | jq -r '.status // "unknown"')"
  updated_at="$(printf '%s' "$response" | jq -r '.updated_at // "unknown"')"
  assignee="$(printf '%s' "$response" | jq -r '.assignee_id // "unassigned"')"

  printf '%s status=%s assignee=%s updated_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$status" "$assignee" "$updated_at"
  sleep 30
done
