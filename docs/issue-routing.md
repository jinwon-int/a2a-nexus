# A2A Issue Routing Policy

> **Status:** phase 0 policy for [a2a-plane#515](https://github.com/jinwon-int/a2a-plane/issues/515). It does not transfer existing issues or approve a canonical flip.

## Default Routing

Open ambiguous or cross-repo issues in `a2a-plane` first. Route implementation
work by source surface only when the boundary is clear.

| Label | Owning surface | Use when |
| --- | --- | --- |
| `source:a2a-plane` | `a2a-plane` | Public umbrella docs, contracts, fixtures, readiness gates, topology decisions, issue routing, release policy. |
| `source:a2a-broker` | `a2a-broker` | Broker API, task lifecycle, worker registry, dispatch/readiness gates, durable evidence, broker persistence. |
| `source:a2a-docker-runner` | `a2a-docker-runner` | Isolated execution, checkout hygiene, PR/Done/Block evidence, runner CLI/package, runner release dry-run evidence. |
| `source:openclaw-plugin-a2a` | `openclaw-plugin-a2a` | OpenClaw adapter behavior, request/status/cancel mapping, diagnostics, OpenClaw peer boundary. |

Do not create or use `source:agent-olympics` in A2A routing. Agent Olympics is
an independent repository and not an A2A implementation package.

## Future Canonical Flip Policy

If a future canonical flip is explicitly approved:

- keep closed issues and PRs in their original repos;
- add README and pinned-issue backlinks from split repos to `a2a-plane`;
- route new work to `a2a-plane` using the source labels above;
- preserve old issue/PR URLs as provenance;
- avoid close keywords that accidentally close issues in the wrong repo.

Until that approval exists, split repo issues and PRs remain authoritative for
their implementation surfaces.
