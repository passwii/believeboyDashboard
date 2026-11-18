#!/usr/bin/env bash
# Verify the scheduled-report Obscura/CDP screenshot path against a live browser.
#
# Usage:
#   OBSCURA_CDP_URL=http://127.0.0.1:9222 bash backend-go/scripts/verify-obscura-screenshot.sh
#   OBSCURA_REPORT_OUT=/tmp/report.png ...      # keep the rendered daily report
#   OBSCURA_EXPECT_CJK=present|missing ...      # assert CJK glyph readability
#
# The script runs the Obscura/Capture tests, renders the sample daily report to
# PNG, and reports the PNG dimensions, byte size, and CJK font status. It never
# writes to a database.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
go_bin="${GO_BIN:-}"
if [[ -z "${go_bin}" ]]; then
  if command -v go >/dev/null 2>&1; then
    go_bin="$(command -v go)"
  elif [[ -x /usr/local/go/bin/go ]]; then
    go_bin=/usr/local/go/bin/go
  else
    echo "go toolchain not found; set GO_BIN" >&2
    exit 1
  fi
fi

cd "${repo_root}/backend-go"
cdp_url="${OBSCURA_CDP_URL:-http://127.0.0.1:9222}"
report_out="${OBSCURA_REPORT_OUT:-/tmp/obscura-report.png}"

echo "== Obscura CDP endpoint: ${cdp_url}"
curl -fsS --max-time 5 "${cdp_url%/}/json/version" >/dev/null \
  || { echo "CDP discovery failed: ${cdp_url}" >&2; exit 1; }

echo "== go test ./internal/scheduledreport -run 'Obscura|Capture'"
OBSCURA_CDP_URL="${cdp_url}" \
OBSCURA_REPORT_OUT="${report_out}" \
"${go_bin}" test ./internal/scheduledreport -run 'Obscura|Capture' -v -count=1

if [[ -f "${report_out}" ]]; then
  echo "== rendered report: ${report_out}"
  file "${report_out}"
  stat -c 'bytes=%s mtime=%y' "${report_out}" 2>/dev/null || stat -f 'bytes=%z mtime=%Sm' "${report_out}"
fi
