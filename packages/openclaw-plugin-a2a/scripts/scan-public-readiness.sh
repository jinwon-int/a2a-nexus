#!/usr/bin/env bash
set -euo pipefail

test -f openclaw.plugin.json
test -f package.json
test -f docs/public-stable-readiness.md

if find . -maxdepth 2 \( -name AGENTS.md -o -name SOUL.md -o -name USER.md -o -name TOOLS.md -o -name HEARTBEAT.md -o -name IDENTITY.md -o -name .openclaw \) | grep -q .; then
  echo "public-readiness scan failed: runtime bootstrap file present" >&2
  exit 1
fi

node -e "const p=require('./package.json'); if (!p.peerDependencies?.openclaw) throw new Error('missing openclaw peer boundary');"
echo "plugin public-readiness scan ok"
