# A2A Nexus public alpha landing draft

This is a repo-tracked landing-page draft for [#1181](https://github.com/jinwon-int/a2a-nexus/issues/1181). It is content only. It does not set the GitHub homepage field, deploy a website, publish a package, create a release, or announce a launch.

## Hero

**A2A Nexus is an operator-gated A2A task and evidence control plane for safe delegated work.**

It gives maintainers a broker/worker runtime, source-only review bridge, isolated patch execution path, and finalizer-ready evidence reports so delegated work can be inspected before it changes public code or live systems.

## Why it exists

Public A2A protocol and SDK work focuses on interoperable agent-to-agent surfaces. A2A Nexus focuses on the operational layer around that work: routing tasks, constraining workers, collecting evidence, and making closeout decisions auditable.

A2A Nexus complements the public A2A ecosystem; it is not affiliated with or endorsed by a2aproject.

## Try it locally first

Start with the local-only path:

1. [README first screen](../README.md)
2. [Five-minute local quickstart](quickstart.md)
3. [Public architecture](architecture.md)
4. [Contribution entry points](contribution-entry-points.md)

The quickstart is intentionally loopback/local. Do not use production broker URLs, production credentials, private node names, provider identifiers, Telegram identifiers, production data, raw session dumps, or host-local paths in public evidence.

## Public alpha status

This repository is publicly readable and remains public alpha:

- no stable release is implied;
- no npm, Docker, or GHCR package is published by this draft;
- no GitHub homepage, domain, or docs-site deployment is configured by this draft;
- no production deploy, broker/Gateway/worker restart, provider send, Telegram send, DB/outbox/ACK/replay mutation, secret movement, visibility change, history rewrite, or force push is authorized.

## External discoverability

External directory outcomes are tracked in [#1160](https://github.com/jinwon-int/a2a-nexus/issues/1160) and [external-listings.md](external-listings.md). Keep #1160 open until all targeted external directory PRs have final outcomes.

## Future approval path

A maintainer may later approve a homepage/docs-site task. That task must separately decide:

- whether this draft is the approved landing content;
- where it is hosted;
- whether the GitHub homepage metadata should be set;
- which verification commands and public-readiness checks gate the change;
- which promotion, release, or package actions remain out of scope.

Until that happens, the repository homepage field should remain blank and this file should be treated as draft content only.
