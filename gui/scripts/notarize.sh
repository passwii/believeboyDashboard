#!/usr/bin/env bash
# BelieveBoy GUI — Apple 公证（notarytool）脚本
#
# 前置条件：
#   1. 已用 Developer ID 签名（见 bundle.sh + APPLE_SIGN_IDENTITY）
#   2. 已用 `xcrun notarytool store-credentials believeboy-gui` 存好凭据，
#      或提供环境变量：APPLE_ID / APPLE_TEAM_ID / APPLE_APP_PASSWORD
#      （App-Specific Password，不是账号密码）
#
# 用法：
#   ./scripts/notarize.sh                   # 公证 dist/BelieveBoy GUI.app
#   ./scripts/notarize.sh dist/xxx.dmg      # 公证任意文件（.app/.zip/.dmg）
#
# 产出：公证通过后自动 stapler（staple），Gatekeeper 即可放行。
set -euo pipefail

GUI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$GUI_DIR/dist"
TARGET="${1:-$DIST_DIR/BelieveBoy GUI.app}"

if [ ! -e "$TARGET" ]; then
  echo "文件不存在: $TARGET" >&2
  echo "先运行 ./scripts/bundle.sh（含 APPLE_SIGN_IDENTITY）" >&2
  exit 1
fi

# ---------- 凭据解析 ----------
CRED_PROFILE="believeboy-gui"
ARGS=()
if [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_APP_PASSWORD:-}" ]; then
  ARGS+=(--apple-id "$APPLE_ID" --password "$APPLE_APP_PASSWORD")
  [ -n "${APPLE_TEAM_ID:-}" ] && ARGS+=(--team-id "$APPLE_TEAM_ID")
  echo "==> 使用环境变量凭据"
else
  ARGS+=(--keychain-profile "$CRED_PROFILE")
  echo "==> 使用 keychain 凭据 profile: $CRED_PROFILE"
fi

# ---------- 提交公证（--wait 同步等待结果） ----------
echo "==> xcrun notarytool submit（等待结果，可能数分钟）"
xcrun notarytool submit "$TARGET" --wait "${ARGS[@]}"

# ---------- 追加 staple ----------
echo "==> stapler staple"
xcrun stapler staple "$TARGET"

echo
echo "==> spctl --assess --verbose=4"
spctl --assess --verbose=4 "$TARGET" || {
  echo "spctl 仍未通过，请检查签名与公证日志" >&2
  exit 1
}
echo "✅ 公证 + staple 完成，Gatekeeper 通过"
