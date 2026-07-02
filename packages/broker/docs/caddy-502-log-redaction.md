# Caddy 502 Log Redaction Guide

**Issue:** jinwon-int/a2a-broker#892
**Date:** 2026-05-22

## Problem

When the A2A broker Docker container is restarting or stopped, Caddy returns
`502 Bad Gateway` to callers. Caddy's default error response and access logs
may include request metadata — including the `X-A2A-Edge-Secret` header and
other A2A auth/identity headers.

This creates a **secret-leakage risk** through:

1. **Access logs** — Caddy access logs that include `{http.request.header.*}`
   placeholders capture and persist the edge secret in plaintext on disk.
2. **Error pages** — Caddy's default error handler may echo request fields
   back to the caller when debug mode is enabled or custom error templates
   reference header placeholders.
3. **Debug/diagnostic output** — `caddy adapt`, `journalctl -u caddy`, and
   other diagnostic commands may render raw request headers.

## Impact Window

The primary risk window is **broker Docker restart** (approximately 10
seconds, observed 2026-05-22 22:10:02–22:10:12 KST for the brokeralpha broker).
During this window every proxied request receives a 502, and any request
header present in those requests can appear in Caddy diagnostics.

## Solution: Caddy Configuration Reference

The reference Caddy configuration at `config/caddy-broker-log-redaction.caddy`
addresses all three leakage paths:

| Path | Mechanism | Effect |
|------|-----------|--------|
| Access logs | Global `log_redact` directive | Replaces `X-A2A-Edge-Secret` value with `REDACTED` in all log output |
| Error pages | `handle_errors` block with generic 502 response | No request metadata in 502 response body |
| Log format | `filter` log format excluding `request>headers` | Request headers never written to access log files |

### Key directives

```caddy
# Global: redact sensitive headers from all log output
{
    log_redact "http.request.header.X-A2A-Edge-Secret"
    log_redact "http.request.header.X-A2A-Requester-Id"
    log_redact "http.request.header.X-A2A-Requester-Role"
}
```

```caddy
# Custom 502 handler — generic, no request metadata
handle_errors {
    @502 expression `{err.status_code} == 502`
    respond @502 "Service Unavailable" 502 { close }
    respond "Error {err.status_code}" {err.status_code}
}
```

```caddy
# Safe log format — exclude all request headers
log {
    format filter {
        wrap json
        fields {
            request>headers delete
            request>tls delete
            user_id delete
        }
    }
}
```

## Required Caddy Version

The `log_redact` global option requires **Caddy >= 2.7.0**.

Verify with:
```bash
caddy version
```

If Caddy is older, upgrade before applying the redaction configuration.

## Apply and Verify

```bash
# 1. Backup current config
cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak_$(date +%Y%m%d_%H%M%S)

# 2. Validate syntax
caddy validate --config /etc/caddy/Caddyfile

# 3. Reload (no downtime)
caddy reload --config /etc/caddy/Caddyfile

# 4. Verify redaction is active by triggering a 502 and checking logs.
#    With the broker stopped, send a request with edge secret:
curl -v -H 'X-A2A-Edge-Secret: <edge-secret-placeholder>' https://broker.example.com/tasks/xyz

# 5. Check Caddy access log — edge secret must NOT appear:
tail -1 /var/log/caddy/broker-access.log | jq .
# The request should show status 502, but X-A2A-Edge-Secret must be
# either absent or REDACTED.

# 6. Restart broker after verification:
docker compose up -d
```

## Rollback

If the redaction config causes issues:

```bash
cp /etc/caddy/Caddyfile.bak_YYYYMMDD_HHMMSS /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile
caddy reload --config /etc/caddy/Caddyfile
```

## Preflight Validation

A preflight script is available for CI/local validation:

```bash
node scripts/caddy-log-redaction-preflight.mjs
node scripts/caddy-log-redaction-preflight.mjs --json
```

The preflight checks:
- Reference config file exists and is parseable
- `log_redact` directive covers `X-A2A-Edge-Secret`
- `handle_errors` block is present with a 502 handler
- Log format excludes request headers
- No hardcoded secrets in the reference config

## Risk Notes

- **If Caddy < 2.7.0**: The `log_redact` global option is unavailable.
  Fallback: use the `filter` log format to exclude all request headers,
  and use `handle_errors` for generic 502 responses. The edge secret
  may still appear in Caddy's own debug/startup logging.
- **Log rotation**: Ensure the access log file path in the reference
  config matches the production log path. Inconsistent paths mean
  redaction won't apply to the active log.
- **Other sensitive headers**: The reference config redacts
  `X-A2A-Requester-Id` and `X-A2A-Requester-Role` as a defense-in-depth
  measure. Add any other custom auth headers your deployment uses.
- **This is a reference config only**: The live Caddyfile at
  `/etc/caddy/Caddyfile` is the authoritative configuration. The
  reference file in this repo must match the live config's redaction
  posture.

## Related

- [a2a-broker-ops-handoff-20260413.md](./a2a-broker-ops-handoff-20260413.md) — ops handoff with Caddy config locations
- [edge-secret-rotation-runbook.md](./edge-secret-rotation-runbook.md) — secret rotation procedure
- [config/caddy-broker-log-redaction.caddy](../config/caddy-broker-log-redaction.caddy) — reference Caddy configuration
