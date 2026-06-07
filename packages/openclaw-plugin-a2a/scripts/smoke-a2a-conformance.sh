#!/usr/bin/env bash
set -euo pipefail

npm run build
node -e "const fs=require('fs'); for (const f of ['dist/index.js','dist/api.js','dist/config.js','dist/openclaw.plugin.json']) { if (!fs.existsSync(f)) throw new Error('missing '+f); }"
node -e "const manifest=require('./dist/openclaw.plugin.json'); if (!manifest.id && !manifest.name) throw new Error('invalid plugin manifest');"
echo "plugin a2a conformance smoke ok"
