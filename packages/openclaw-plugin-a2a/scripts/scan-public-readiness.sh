#!/usr/bin/env bash
set -euo pipefail

# ── Public-readiness / secret-scan pre-commit / CI guard ──────────────
# Scans tracked repo files for common secret / non-public patterns.
# Pure grep + git; zero runtime dependencies, zero live secrets, zero network.
# Returns 0 (clean) or 1 (findings = Block evidence).
#
# Safety: this scanner never sends data, reads from env, or touches secrets.
# It only pattern-matches tracked git files.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Tracked files to scan — source, docs, configs, scripts.
SCAN_ALL="$(git ls-files -- '*.ts' '*.mjs' '*.sh' '*.md' '*.json' '*.yml' '*.yaml' ':!:package-lock.json' ':!:tsconfig.json' ':!:tsconfig.*.json')"

# Config-only files (JSON/YML) for notification-target scanning.
SCAN_CONFIGS="$(git ls-files -- '*.json' '*.yml' '*.yaml' ':!:package-lock.json' ':!:package.json' ':!:tsconfig.json' ':!:tsconfig.*.json' ':!:test/fixtures/*')"

declare -a FINDINGS=()

echo "=== plugin-a2a public-readiness scan ==="
echo ""

# ── Rule 1: raw API-key-like strings ──────────────────────────────────
# Common secret token prefixes detected in tracked files.
echo "[1/6] raw API-key / token patterns …"
T1=0
PATTERNS_KEYS=(
  'sk-[a-zA-Z0-9]{20,}'
  'key-[a-zA-Z0-9]{20,}'
  'xox[bprsa]-[0-9A-Za-z-]{10,}'
  'gh[pousr]_[A-Za-z0-9]{20,}'
  '[?&]token=[A-Za-z0-9._-]{20,}'
  ': "ghp_[A-Za-z0-9]{20,}"'
  ': "gho_[A-Za-z0-9]{20,}"'
  ': "ghs_[A-Za-z0-9]{20,}"'
  ': "ghu_[A-Za-z0-9]{20,}"'
  ': "ghr_[A-Za-z0-9]{20,}"'
)

for pattern in "${PATTERNS_KEYS[@]}"; do
  while IFS=: read -r file line content; do
    # Skip known-safe contexts
    if echo "$content" | grep -qiE 'example|placeholder|test|dummy|fake|mock|0000+|document|reference|pattern' 2>/dev/null; then
      continue
    fi
    FINDINGS+=("SECRET_TOKEN $file:$line: $content")
    T1=$((T1 + 1))
  done < <(echo "$SCAN_ALL" | xargs grep -nE "$pattern" 2>/dev/null || true)
done
echo "  → $T1 potential token/API-key findings"

# ── Rule 2: non-example broker URLs in non-test docs/code ─────────────
echo "[2/6] non-example / private broker URLs …"
T2=0
while IFS=: read -r file line content; do
  # Skip GitHub issue/PR links
  if echo "$content" | grep -qE 'github\.com/'; then
    continue
  fi
  # Skip known-safe domains
  url_part="$(echo "$content" | grep -oE 'https://[a-zA-Z0-9._/-]+' | head -1 || true)"
  if [ -z "$url_part" ]; then continue; fi
  if echo "$url_part" | grep -qE 'example\.test|example\.com|conformance\.test|localhost|127\.0\.0\.1|0\.0\.0\.0|broker\.example'; then
    continue
  fi
  # Skip test files
  if echo "$file" | grep -qE 'test/|tests/|\.test\.'; then
    continue
  fi
  FINDINGS+=("PRIVATE_URL $file:$line: $content")
  T2=$((T2 + 1))
done < <(echo "$SCAN_ALL" | xargs grep -nEo 'https://[a-zA-Z0-9._/-]+[^"'"'"' ]' 2>/dev/null || true)
echo "  → $T2 potential non-example URL findings"

# ── Rule 3: numeric Telegram chat IDs (not placeholder/example) ───────
echo "[3/6] numeric Telegram chat IDs …"
T3=0
while IFS=: read -r file line content; do
  if echo "$content" | grep -qiE '<operator-chat-id>|example|placeholder|test-chat|0000+|operator-chat'; then
    continue
  fi
  if echo "$file" | grep -qE 'test/|tests/|\.test\.'; then
    continue
  fi
  FINDINGS+=("TELEGRAM_ID $file:$line: $content")
  T3=$((T3 + 1))
done < <(echo "$SCAN_ALL" | xargs grep -nE '(?:telegram|chatId|chat_id|chat\.id)\s*[:=]\s*["'"'"']?\d{6,}' 2>/dev/null || true)
echo "  → $T3 potential numeric Telegram chat ID findings"

# ── Rule 4: raw edgeSecret / literal secret values in configs ─────────
echo "[4/6] raw edgeSecret / literal secret values …"
T4=0
while IFS=: read -r file line content; do
  if echo "$content" | grep -qiE '\$\{[A-Za-z0-9_]+\}|<edge.secret>|example|placeholder|test-secret|dev-secret|dummy|env.ref'; then
    continue
  fi
  if echo "$file" | grep -qE 'test/|tests/|\.test\.'; then
    continue
  fi
  FINDINGS+=("EDGE_SECRET $file:$line: $content")
  T4=$((T4 + 1))
done < <(echo "$SCAN_ALL" | xargs grep -nE 'edgeSecret["'\'']?\s*:\s*"\S{8,}"' 2>/dev/null || true)
echo "  → $T4 potential raw edgeSecret findings"

# ── Rule 5: live notification targets in config files (not docs/code) ─
echo "[5/6] live notification target configs …"
T5=0
# Only scan JSON config files (not docs, not ts, not md) for enabled notification targets.
while IFS=: read -r file line content; do
  if echo "$content" | grep -qiE '<operator-chat-id>|example|placeholder|test-target|operator-chat|dummy|0000+'; then
    continue
  fi
  if echo "$file" | grep -qE 'test/|tests/|\.test\.'; then
    continue
  fi
  FINDINGS+=("NOTIFICATION_TARGET $file:$line: $content")
  T5=$((T5 + 1))
done < <(echo "$SCAN_CONFIGS" | xargs grep -nE '"enabled"\s*:\s*true' 2>/dev/null | grep -iE 'notification' || true)
echo "  → $T5 potential live notification target findings"

# ── Rule 6: runtime context files that must stay git-ignored ──────────
echo "[6/6] runtime/bootstrap context file leakage …"
T6=0
CONTEXT_FILES=("AGENTS.md" "SOUL.md" "USER.md" "TOOLS.md" "HEARTBEAT.md" "IDENTITY.md")
for f in "${CONTEXT_FILES[@]}"; do
  if git ls-files --error-unmatch "$f" >/dev/null 2>&1; then
    FINDINGS+=("CONTEXT_LEAK $f is tracked in git (must be git-ignored)")
    T6=$((T6 + 1))
  fi
done
# .openclaw/ directory check
if git ls-files '.openclaw/' 2>/dev/null | grep -q '.'; then
  FINDINGS+=("CONTEXT_LEAK .openclaw/ files are tracked in git (must be git-ignored)")
  T6=$((T6 + 1))
fi
echo "  → $T6 context-file leakage findings"

# ── Summary ───────────────────────────────────────────────────────────

echo ""
if [ ${#FINDINGS[@]} -eq 0 ]; then
  TOTAL_TRACKED="$(echo "$SCAN_ALL" | wc -l)"
  echo "=== SCAN PASSED: no public-readiness/secret findings ==="
  echo "Scanned $TOTAL_TRACKED tracked files."
  echo "All rules clean: tokens, URLs, Telegram IDs, edge secrets, notification targets, context files."
  exit 0
else
  TOTAL_TRACKED="$(echo "$SCAN_ALL" | wc -l)"
  echo "=== SCAN FAILED: ${#FINDINGS[@]} public-readiness/secret finding(s) ==="
  echo ""
  for finding in "${FINDINGS[@]}"; do
    echo "  BLOCKED: $finding"
  done
  echo ""
  echo "Scanned $TOTAL_TRACKED tracked files."
  echo "Review each finding. If it is a false positive (docs example, test fixture, or placeholder), update the exclusion patterns in scripts/scan-public-readiness.sh."
  exit 1
fi
