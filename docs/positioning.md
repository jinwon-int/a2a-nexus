# A2A Nexus positioning

A2A Nexus sits at the intersection of **Broker / Worker runtime** and **Control plane / evidence finalization** in the A2A ecosystem.

| Landscape category | Representative public projects | A2A Nexus position |
|---|---|---|
| Protocol specification | `a2aproject/A2A` | Follows the public protocol direction; does not redefine it. |
| SDKs | `a2a-python`, `a2a-js`, `a2a-java`, `trpc-a2a-go` | Adds an operator-gated broker/evidence plane around SDK clients. |
| Broker / worker runtime | emerging broker examples | Provides a reference broker/worker task lifecycle with durable evidence. |
| Control plane / inspector | `a2a-inspector`, gateway projects | Provides finalizer-ready evidence, closeout reports, and source-only analysis bridges. |
| Directories / awesome lists | awesome-a2a lists and directories | Listing submissions are prepared but operator-gated. |

## Differentiators

- **Write-set safety rule**: worker activity is routed through broker validation rather than uncontrolled direct mutation.
- **Finalizer-with-evidence contract**: task outputs are classified for evidence quality before final decisions.
- **Source-only analysis bridge**: read-only review lanes can produce broker-backed evidence without live side effects.
- **Isolated patch runner**: implementation work can be separated from broker/operator approval boundaries.

A2A Nexus is an alpha reference implementation, not an official a2aproject distribution or endorsement.
