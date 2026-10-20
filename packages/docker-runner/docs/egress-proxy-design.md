# Egress control for trusted patch lanes — design (#2395 stage 2)

Status: **implemented behind `A2A_DOCKER_RUNNER_EGRESS_MODE` (default `off`).**
Proxy component (§5.4, #2415) and runner wiring (§5.3, §5.6) are in. No node runs
it until an operator sets the mode and runs `install --egress` (per-node approval).

Stage 1 (#2397) made the gap visible:
`doctor` reports `containerHardening.detail.egress.mode = "unrestricted"` and the
`unrestricted_egress` relaxation on every trusted worker. This document proposes
how to close it. Nothing here changes runtime behaviour until a later PR ships the
code behind an opt-in flag that defaults to `off`.

## 1. Problem

Trusted-operator patch lanes run the model CLI inside the task container with
`--network bridge` (`src/config.ts:227`), so the container can reach any host on
the internet. The claude-code profile allows `Bash`; the codex profile runs with
`--sandbox danger-full-access`. Patch tasks read untrusted input (issue bodies,
repository content, tool output), so a prompt injection has an open exfiltration
and download path. harness2 reported the same failure mode in its own benchmarks:
a Codex rollout with its sandbox disabled downloaded the task's grading rubric
without being asked to (`google-research/harness2` `docs/EXPERIMENTS.md:93-98`).

The fleet decision in #1374 was already "no fully open docker-runner outbound;
deny-by-default plus an allowlist". It was never implemented for patch lanes:

- `src/egress-allowlist-proxy.ts` is **not** a network proxy. It is a host-side
  fetch library for the K2 retrieval lane (`fetchWithEgressAllowlist`, DNS
  pinning, internal-range denial, signed GitHub raw snapshots). Its SSRF guards
  (`isDeniedInternalHostname`, `isDeniedInternalIp`, `createPinnedLookup`) are
  reusable; the module itself does not sit between a container and the network.
- `A2A_DOCKER_RUNNER_EGRESS_ALLOWLIST_HOSTS` is parsed and validated but nothing
  enforces it.

## 2. What a patch container actually needs

Everything network-related happens **inside** the container; the host never
clones (evidence at commit `75250447`):

| Need | Where | Hosts |
| --- | --- | --- |
| Clone, push, PR, issue comments | `script-generators.ts:273` (`git clone`), `task-normalizer.ts:379,532,584,588,603` (`gh issue comment`, `git push`, `gh pr create`, `gh pr update-branch`) | `github.com`, `api.github.com` |
| claude-code model calls | Claude CLI with OAuth token or a refresh-token-stripped credentials copy (`profiles/claude-code.sh`); refresh happens on the host (`claude-host-refresh.ts`) | Anthropic API |
| codex model calls **and token refresh** | `CODEX_HOME=/run/secrets/codex-dir`, `auth.json` writable, refresh inside the container (`runner.ts:295-319`) | OpenAI API + OpenAI auth endpoint |
| danso model calls | `DANSO_GLM_BASE_URL` / `DANSO_GLM_ENDPOINT` (`profiles/danso.sh:166`) | Z.ai GLM endpoint |
| Installs (optional) | agent-initiated, or post-patch verification commands (`task-normalizer.ts:829-840`) | npm / PyPI registries, only if tasks need them |
| `gh` self-install fallback | `script-generators.ts:110-134` (images bake `gh`, normally unused) | `cli.github.com`, apt mirrors |

The host-side evidence collector (`github-evidence.ts`) calls `api.github.com`
from the host after the container exits; it is outside the container and out of
scope.

Exact model/telemetry hostnames are **not** fixed by this repo — the CLIs choose
them. That is why §5 starts with an observe mode instead of a hand-written list.

## 3. Constraints in the current code

- `config.network` accepts only `bridge|host|none` (`config.ts:275-276`).
- `buildRunArgs` (`runner.ts:1098-1286`) has no `--dns`, `--add-host`, or proxy
  env hook.
- Task-supplied `HTTP(S)_PROXY`/`ALL_PROXY`/`NO_PROXY` are deliberately dropped
  (`runner.ts:1045-1062`); only `A2A_*`, `RUN_ID`, `TRACE_ID` pass. This must stay:
  proxy settings have to be **runner-owned**, never task-controlled.
- The claude patch bridge strips every env var not on its child allowlist
  (`claude-a2a-patch-bridge.mjs:194-224`), so proxy vars would not reach `claude`
  today.
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` / `DISABLE_AUTOUPDATER` are on that
  allowlist but nothing sets them, so the CLI's default telemetry/update traffic is
  on — it widens any allowlist for no task benefit.
- Public mode (`network: none`) has no working model path at all; every model
  profile is effectively trusted-only.

## 4. Options considered

| Option | How | Verdict |
| --- | --- | --- |
| A. Internal network + allowlist forward proxy | Per-node Docker network created with `--internal` (no route out). A long-lived proxy container joins that network and the normal bridge. Task containers join only the internal network and get runner-owned `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY`. The proxy allows `CONNECT host:443` only for allowlisted hostnames, resolves DNS itself, and refuses internal ranges. | **Recommended.** Fail-closed by construction: a tool that ignores the proxy env gets no route instead of a bypass. No host iptables. Reuses the existing SSRF guards for the proxy's own resolution. |
| B. Host iptables (`DOCKER-USER`) by destination IP | Allow resolved IPs of allowlisted hosts, drop the rest. | Rejected. CDN/anycast IPs churn; rules drift; hard to audit per task; touches host firewall on every node. |
| C. Proxy on the host bridge gateway + iptables to force it | Host process proxy, drop all other egress from the runner bridge. | Rejected for v1. Needs host firewall changes and still relies on rules staying correct; A gets the same guarantee from Docker's `--internal`. |
| D. Per-tool sandboxes (codex sandbox, claude permission rules) | Rely on CLI-level network restrictions. | Insufficient alone. Patch lanes need shell; CLI sandboxes are disabled precisely there. Complementary only. |

## 5. Proposed design (option A)

### 5.1 Modes

`A2A_DOCKER_RUNNER_EGRESS_MODE = off | observe | enforce` (default `off` = today).

- `off` — current behaviour (`--network bridge`).
- `observe` — task containers use the internal network and the proxy, but the
  proxy **allows every non-internal host** and logs each `CONNECT` (host, port,
  bytes, duration, run token). Purpose: learn the real per-profile host set from
  production tasks before blocking anything.
- `enforce` — the proxy allows only the effective allowlist; everything else gets
  `403` and a structured deny record.

Internal ranges (RFC 1918, loopback, link-local incl. `169.254.169.254`, ULA,
the Docker bridge ranges) are denied in **both** `observe` and `enforce`, using
`isDeniedInternalHostname`/`isDeniedInternalIp` after the proxy resolves the name.

### 5.2 Allowlist

Effective allowlist = profile base set ∪ `A2A_DOCKER_RUNNER_EGRESS_ALLOWLIST_HOSTS`.

- Base sets live in code per profile (`claude-code`, `codex`, `danso`, …) and
  start from §2. They are finalized from observe-mode logs, not guessed.
- Exact hostnames only; no wildcards in v1. A suffix rule can be added later if
  observe data shows a CDN pattern that needs it.
- Port 443 only (`CONNECT`). Plain HTTP and other ports are denied in `enforce`.

### 5.3 Runner changes (later PR, behind `EGRESS_MODE`)

1. `config.ts`: parse `A2A_DOCKER_RUNNER_EGRESS_MODE`; in `observe`/`enforce`,
   set the task network to the managed internal network name
   (`a2a-egress-<node>`), extending the `bridge|host|none` validation for that one
   managed name only.
2. `runner.ts buildRunArgs`: in `observe`/`enforce`, add runner-owned
   `-e HTTPS_PROXY=http://a2a-egress-proxy:3128`, `-e HTTP_PROXY=…`,
   `-e NO_PROXY=` (empty), plus `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` and
   `DISABLE_AUTOUPDATER=1`. The existing block on task-supplied proxy vars stays.
3. Proxy authentication: the runner passes a per-run credential
   (`http://<runToken>:<nonce>@a2a-egress-proxy:3128`) so the proxy can attribute
   every `CONNECT` to `a2a.run.id` without trusting the container.
4. `claude-a2a-patch-bridge.mjs`: add `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` to
   the child env allowlist (values come only from the runner-set container env).
5. Result/evidence: a task that hits a deny in `enforce` gets a structured
   `egress_denied` entry (`host`, `port`, `count`) in its result, so a missing
   allowlist entry shows up as a named cause instead of a generic tool failure.
6. `doctor`: `containerHardening.detail.egress` becomes
   `{ mode: "proxy-observe" | "proxy-enforce", allowlistConfigured, proxyWired: true }`
   when the proxy container is healthy and the internal network exists; a
   readiness check fails `run` early (before any model call) if the mode is on and
   the proxy is down — the same "preflight before spending" rule as #2393.

### 5.4 Proxy component

- Small Node CONNECT proxy shipped in the runner image family (no new runtime
  dependency — the runner package declares none), run as a
  long-lived container `a2a-egress-proxy` with `--restart unless-stopped`,
  `--read-only`, `--cap-drop ALL`, non-root.
- DNS resolution happens in the proxy; the resolved IP is checked against the
  internal-range guards and pinned for the connection (`createPinnedLookup`).
- Logs: one JSON line per `CONNECT` to a bounded file under the task root
  (`egress/<date>.jsonl`), rotated by the existing workDir retention. No request
  bodies, no headers beyond host/port.
- Lifecycle is managed by `a2a-docker-runner install --egress` (create network +
  proxy container, idempotent) and reported by `doctor`.

Implemented (`src/egress-proxy.ts`, `src/egress-proxy-main.ts`):

- **CONNECT only.** Plain-HTTP proxy requests get `405` in both modes and are
  logged as `method_not_allowed` with host/port, so observe still shows any task
  that needs plain HTTP. (The design above only required this in `enforce`;
  forwarding plain HTTP would add a second request path for no known need.)
- **Decision order:** credentials → target syntax → internal hostname/IP literal
  → policy (`enforce` denies here, `observe` records `wouldDeny`) → capacity →
  DNS → reject if *any* resolved address is internal → connect to the checked
  address (the pin is the connect address itself; there is no second lookup).
  `enforce` never resolves a non-allowlisted name, so denied hosts leak no DNS.
- **Per-run credentials:** `Proxy-Authorization: Basic <runId>:<token>`,
  checked against `<credentialsDir>/<runId>.sha256` (hex SHA-256 of the token,
  constant-time compare). The token is runner-generated randomness
  (`generateEgressProxyRunToken`, 32 bytes), never a human password, so a fast
  digest is appropriate; tokens shorter than 32 characters are refused. The runner will write one file per run and
  remove it afterwards; the proxy needs read-only access. The entry point refuses
  to start without a credentials directory unless
  `A2A_EGRESS_PROXY_ALLOW_UNAUTHENTICATED=1` (local PoC only).
- **Records:** schema `a2a.egress.connect.v1` — `runId`, `method`, `host`,
  `port`, `decision`, `reason` | `wouldDeny`, `resolvedIp`, `bytesUp`/`bytesDown`,
  `durationMs`. No credentials, headers, or bodies. Day files
  `egress-YYYY-MM-DD.jsonl` (mode 0600) capped per day with one
  `a2a.egress.log-truncated.v1` marker; stdout when no log directory is set.
- **Limits and lifecycle:** 10 s upstream connect timeout, 10 min tunnel idle
  timeout, 256 concurrent tunnels (`503 capacity_exceeded` beyond), `GET /healthz`
  for readiness, `closeTunnels()` on SIGTERM/SIGINT (CONNECT sockets are outside
  the HTTP server's own connection tracking).
- **Entry point env:** `A2A_EGRESS_PROXY_MODE` (required, `observe|enforce`),
  `_LISTEN` (default `0.0.0.0:3128`), `_ALLOWLIST`, `_ALLOWED_PORTS` (default
  `443`), `_CREDENTIALS_DIR`, `_LOG_DIR`, `_LOG_MAX_FILE_BYTES`. These belong to
  the proxy container only; task containers never see them.

### 5.5 Tool compatibility to verify in the PoC

| Tool | Proxy env support | Status |
| --- | --- | --- |
| `git` (HTTPS) | honours `https_proxy`/`HTTPS_PROXY` | OK on a host run against the proxy (answers the 407 challenge, then tunnels); container run pending |
| `gh` | honours `HTTPS_PROXY` | OK on a host run against the proxy; container run pending |
| `claude` CLI | documented `HTTPS_PROXY` support | verify (needs bridge allowlist change) |
| `codex` CLI | Rust HTTP client; env proxy support expected | **verify**, including in-container token refresh |
| danso / GLM client | depends on its HTTP client | **verify** |
| `npm` / `pip` | honour proxy env | only if installs are allowed |

A tool that ignores the proxy env fails closed (no route on the internal network);
the PoC must confirm none of the required tools fall into that bucket.

### 5.6 Runner wiring as implemented (stage 2b)

Differences from §5.3 found while wiring, all fail-closed:

- **Proxy allowlist env:** `A2A_DOCKER_RUNNER_EGRESS_PROXY_ALLOWLIST`, not
  `A2A_DOCKER_RUNNER_EGRESS_ALLOWLIST_HOSTS` — the latter is validated as the K2
  GitHub-retrieval list and rejects anything else. No profile base sets yet;
  `enforce` requires the explicit list (derive it from observe logs).
- **Credentials never in argv:** the proxy URL with the per-run token goes into a
  0600 `--env-file` (docker `-e` values are visible in `ps`). The proxy reads
  only `<runToken>.sha256` digests. Modes are set with explicit `chmod` so a
  restrictive worker umask cannot make the digests unreadable to the proxy.
- **State outside the task root:** `<root>-egress` by default. Under the task
  root, `cleanup` would treat `credentials/` and `logs/` as expired run dirs.
- **Proxy bundle, not the runner dir:** the runner install dir is root-only
  (`0700`/`0600` on the fleet), so a non-root proxy cannot read it. `install
  --egress` copies the three dependency-closed files (`egress-guards.js`,
  `egress-proxy.js`, `egress-proxy-main.js`) plus an ESM `package.json` into
  `<state>/proxy` and mounts that. The internal-range guards moved to
  `egress-guards.ts` (re-exported from `egress-allowlist-proxy.ts`) to keep the
  bundle closed; a test pins the closure. Re-run `install --egress` after a
  runner deploy to pick up proxy changes.
- **Readiness needs a healthcheck:** under `--restart unless-stopped` a
  crash-looping proxy reports `Running=true` between restarts. The container
  has a `/healthz` healthcheck and readiness requires `healthy` and not
  `Restarting`; `install --egress` waits for it.
- **Old images:** the Claude patch bridge carries an `egress-proxy-env`
  capability marker; the claude-code profile fails closed without it when
  `HTTPS_PROXY` is set.

Verified on a host with Docker 29 using test-only names (removed afterwards):
through the proxy `curl` → api.github.com 200 and `git ls-remote` OK;
`curl --noproxy '*'` from the internal network had no route; plain-HTTP to
`169.254.169.254` → 405; wrong token → 407; records attributed to the run id,
with `wouldDeny` for a non-allowlisted host in observe.

## 6. Rollout

1. **Code PR** with `EGRESS_MODE` defaulting to `off` + unit tests (arg building,
   env allowlist, deny records) + a hermetic proxy test (allow/deny/internal-range,
   no live traffic in CI).
2. **PoC on one node** (operator approval): `install --egress`, `EGRESS_MODE=observe`,
   one claude-code patch canary task. Confirm the task completes and the log shows
   the host set.
3. **Fleet observe** (per-node approval) for a soak period long enough to cover
   each active profile (claude-code, codex, danso). Aggregate the observed host
   sets into the base allowlists via a PR.
4. **Enforce on one node**, canary, then fleet (per-node approval). Rollback at any
   step = `EGRESS_MODE=off` (back to `--network bridge`); the proxy container can
   stay running harmlessly.

## 7. Open questions

- Whether containers on an `--internal` network can reach a host-local listener
  (if yes, the proxy could be a host process instead of a container). The design
  assumes a dual-homed proxy container because that works regardless.
- codex token refresh endpoint and danso endpoint hostnames — taken from observe
  logs, not guessed.
- Whether any active task class relies on runtime installs (npm/PyPI). If yes,
  add registries to the relevant profile base set rather than a global allow.
- Termux-native nodes (no Docker runner) are out of scope.

## References

- #2395 (this design), #2397 (stage 1 measurement), #1374 / #2017 (egress
  decision and retrieval lane), #2256 (container hardening), #2393 (preflight).
- harness2 `docs/EXPERIMENTS.md:93-98` (rubric download with sandbox disabled).
