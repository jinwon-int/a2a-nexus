# Contributing

A2A Nexus is a public alpha reference implementation for a fleet-level, operator-gated A2A task/evidence control plane. Feedback and contributions are welcome, but public visibility does not imply stable release support, package publication, production deployment, live operations, external promotion, or relaxed safety boundaries. The contribution flow uses standard GitHub pull requests; see the [PR template](.github/pull_request_template.md) for expected content.

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md) v2.1. By participating, you agree to uphold its standards. Report unacceptable behavior to repository maintainers. If no private contact path is available, open a non-sensitive maintainer-contact request and do not include private details in public issues or PRs. For security vulnerabilities, follow SECURITY.md.

## License

Unless explicitly agreed otherwise, contributions to this repository are submitted under the same license as the repository: MIT.

By opening a pull request, issue patch, or other contribution, you confirm that you have the right to submit the contribution and that it may be distributed under the MIT License.

## Safety boundary

Do not include secrets, credentials, private endpoints, local operator paths, Telegram/provider IDs, production data, or real-looking token fixtures in issues, pull requests, examples, docs, tests, or artifacts.

Do not perform repository visibility changes, tag/release creation, npm/Docker publication, production deploys, Gateway/broker/worker restarts, database mutations, provider sends, terminal-outbox ACK/replay mutations, or secret/credential movement unless an operator explicitly approves that specific action.

## A2A Spec-First Change Protocol

Medium and large A2A changes must start from a lightweight spec-first workflow before implementation. This is a documentation and operating layer; it does not authorize production deploys, Gateway restarts, live canaries, DB/outbox mutations, manual Terminal Brief ACK/replay, releases, secret movement, or visibility changes.

Use `docs/a2a-constitution.md` to classify the change:

- **Small**: short, reversible, single-repo work with no approval-sensitive action may proceed directly.
- **Medium**: write a feature spec and implementation plan before implementation.
- **Large**: write a feature spec, implementation plan, task list, and use a detached execution lane such as TaskFlow or A2A evidence workers.

Templates live in `docs/spec-templates/`:

- `a2a-feature-spec.md`
- `a2a-plan.md`
- `a2a-tasks.md`
- `a2a-clarify.md`
- `a2a-analyze.md`
- `a2a-checklist.md`

Issues or PRs for medium/large changes should link the completed spec and plan. If the spec is unclear, add clarify notes before planning; before execution, run an analysis pass; before implementation and closeout, use the quality checklist. Closeout must include evidence and must name approval-sensitive actions that were not performed.

Use the **A2A spec-first change** issue template for Medium/Large work. Pull requests should fill the spec-first packet section in `.github/pull_request_template.md`; Small PRs may mark spec/plan fields as N/A only when the change is short, reversible, single-repo, and outside approval-sensitive boundaries.


## Public language policy

The default language for public-facing surfaces is English: README, docs intended for external readers, issue templates, PR templates, package metadata, and examples. A bilingual document is allowed when the document states that intent near the top, as in `docs/ecosystem-guide.md`.

Historical records may preserve non-English approval quotes only when they are necessary audit evidence and are kept in `docs/history/` or other explicitly historical fixtures. New public docs should summarize private approvals in role-based English and link the relevant issue/approval record instead of copying personal-channel text.
