# Azure Always-On Runtime (Mission Control + OpenClaw)

This guide operationalizes Mission Control as the control plane with private
OpenClaw runtime and private worker nodes in Azure, so work continues when an
operator laptop is offline.

## Security Model

- Mission Control is the only internet-facing entrypoint, behind Azure
  Application Gateway (WAF/TLS).
- OpenClaw gateway is private-only inside Azure VNet.
- Worker nodes are private-only and pair to OpenClaw gateway from private
  subnet.
- No VM public IPs.
- `AUTH_MODE=local` is acceptable only behind private/VPN or identity-aware edge
  protection. Do not expose bearer-token-only auth directly to the public internet.
- Runtime secrets are fetched from Key Vault via managed identity at boot.
- No plaintext secrets are committed to repository files.

## Deployment Topology

1. Application Gateway (`edge` subnet)
- Public DNS/TLS endpoint for Mission Control.
- Routes UI traffic to Mission Control frontend port.
- Routes API paths (`/api/*`, `/healthz`, `/openapi.json`, `/docs*`, `/redoc`)
  to Mission Control backend port.

2. Mission Control VM (`mc` subnet)
- Runs Docker Compose stack (`frontend`, `backend`, `db`, `redis`,
  `webhook-worker`) under systemd lifecycle.
- Uses managed identity to pull `LOCAL_AUTH_TOKEN` and DB password from
  Key Vault.
- Runs nightly PostgreSQL backups.

3. OpenClaw VM (`ocw` subnet)
- Runs OpenClaw gateway under systemd.
- Token auth enabled, browser disabled, workspace-only filesystem profile.
- Gateway token loaded from Key Vault via managed identity.

4. Worker VMSS (`workers` subnet)
- Runs persistent OpenClaw node host service.
- Nodes pair to private OpenClaw gateway endpoint.
- Instance role names rotate across `builder`, `reviewer`, `security`.

## Service Lifecycle

1. Mission Control
- Systemd unit: `advancedclaw-mc.service`
- Start/stop scripts:
  - `/usr/local/bin/advancedclaw-mc-start`
  - `/usr/local/bin/advancedclaw-mc-stop`
- Backup scripts/timer:
  - `/usr/local/bin/advancedclaw-mc-backup`
  - `advancedclaw-mc-backup.timer`

2. OpenClaw gateway
- Systemd unit: `advancedclaw-ocw-gateway.service`
- Health script:
  - `/usr/local/bin/advancedclaw-ocw-healthcheck`

3. Worker nodes
- Systemd unit: `advancedclaw-worker-node.service`
- Health script:
  - `/usr/local/bin/advancedclaw-worker-healthcheck`

## Secrets and Identity

1. Key Vault secret names
- `mc-local-auth-token`
- `mc-postgres-password`
- `ocw-gateway-token`

2. Retrieval path
- Managed identity token from IMDS endpoint.
- Secret value pulled via Key Vault REST API.
- Rendered to local env files with `0600/0640` permissions.

3. Helper for Mission Control env rendering
- Script: `scripts/azure/render_env_from_key_vault.sh`

## OpenClaw Worker Registration Strategy

1. Worker VMSS instances start `openclaw node run` with deterministic display
name (`wrk-builder-*`, `wrk-reviewer-*`, `wrk-security-*`).
2. OCW operator approves pending pairing requests:
- `/usr/local/bin/advancedclaw-approve-worker-nodes`
3. Mission Control uses private OCW gateway URL from MC VM network path.

## Logs, Metrics, and Recovery

1. Logs
- Mission Control container logs: `docker compose ... logs`
- OpenClaw gateway logs via systemd/journal
- Azure diagnostics to Log Analytics for App Gateway and Key Vault

2. Metrics/health probes
- Mission Control backend: `/healthz`
- Application Gateway probes:
  - frontend `/`
  - backend `/healthz`
- OpenClaw gateway health:
  - `openclaw gateway health --url ws://127.0.0.1:18789 --token ...`

3. Failure recovery
- Systemd restart policies for gateway/node-host service units
- Container restart policies `unless-stopped`
- Daily DB backups with retention policy

## Continuity Smoke Test (Laptop Offline)

1. Start a long-running task assigned to builder in Mission Control.
2. On MC VM, run:
- `scripts/azure/watch_task_progress.sh <base-url> <local-auth-token> <task-id> 900`
3. Disconnect laptop network for 10+ minutes.
4. Reconnect and verify:
- Task status advanced while laptop was offline.
- Mission Control activity timeline reflects worker execution timestamps.
- OpenClaw gateway and node-host services remained healthy.

## Upgrade Path

1. Mission Control
- Update pinned `repo_ref` in runtime config.
- Restart `advancedclaw-mc.service`.
- Validate health checks.

2. OpenClaw
- Update pinned CLI version in runtime config.
- Reprovision/restart `advancedclaw-ocw-gateway.service`.
- Validate gateway + node connectivity.

## Rollback Plan

1. Mission Control rollback
- Checkout previous known-good commit on MC VM.
- Restore latest DB backup if schema rollback is required.
- Restart `advancedclaw-mc.service`.

2. OpenClaw rollback
- Reinstall previous OpenClaw CLI version.
- Restore previous `/etc/openclaw/openclaw.json` and env files from VM backup.
- Restart `advancedclaw-ocw-gateway.service`.

3. Worker rollback
- Restart VMSS instances with previous node runtime bootstrap template.
- Re-approve worker pairing if node identities changed.
