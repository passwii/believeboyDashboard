#!/usr/bin/env bash
# BelieveBoy GUI — macOS .app 打包脚本
#
# 用法：
#   ./scripts/bundle.sh                # 仅打 .app（ad-hoc 签名，本机可跑）
#   ./scripts/bundle.sh --dmg          # 额外产出 .dmg
#   APPLE_SIGN_IDENTITY="Developer ID Application: X (TEAMID)" ./scripts/bundle.sh
#                                     # 用 Developer ID 正式签名（--options runtime）
#
# 产出：gui/dist/BelieveBoy GUI.app  (+ dist/BelieveBoy GUI.dmg，--dmg 时)
#
# 说明：
# - 采用手写 bundle 而非 cargo-bundle：cargo-bundle 是 `cargo install` 的
#   subcommand，作为 dev-dependency 只编译库不提供 `cargo bundle` 命令，
#   且 0.6 已停更；手写脚本零外部依赖、离线可用、可精确控制 Info.plist。
# - 图标/资源全部 include_bytes! 编译进二进制，bundle 只拷贝可执行文件
#   与 Info.plist / AppIcon.icns。
set -euo pipefail

# ---------- 路径 ----------
GUI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$GUI_DIR/dist"
APP_NAME="BelieveBoy GUI"
APP_DIR="$DIST_DIR/$APP_NAME.app"
BIN_NAME="believeboy-gui"
BUNDLE_ID="com.believeboy.gui"
VERSION="0.1.0"

MAKE_DMG=false
for arg in "$@"; do
  case "$arg" in
    --dmg) MAKE_DMG=true ;;
    *) echo "未知参数: $arg" >&2; exit 2 ;;
  esac
done

# ---------- 1. release 构建 ----------
echo "==> cargo build --release -p gui-app"
cargo build --release -p gui-app --manifest-path "$GUI_DIR/Cargo.toml"
BINARY="$GUI_DIR/target/release/$BIN_NAME"
[ -x "$BINARY" ] || { echo "构建产物不存在: $BINARY" >&2; exit 1; }

# ---------- 2. 组装 .app ----------
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources"

cat > "$APP_DIR/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>$BIN_NAME</string>
  <key>CFBundleIdentifier</key>
  <string>$BUNDLE_ID</string>
  <key>CFBundleName</key>
  <string>$APP_NAME</string>
  <key>CFBundleDisplayName</key>
  <string>$APP_NAME</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>$VERSION</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>LSMinimumSystemVersion</key>
  <string>15.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>LSApplicationCategoryType</key>
  <string>public.app-category.business</string>
</dict>
</plist>
PLIST

cp "$BINARY" "$APP_DIR/Contents/MacOS/$BIN_NAME"
if [ -f "$GUI_DIR/assets/AppIcon.icns" ]; then
  cp "$GUI_DIR/assets/AppIcon.icns" "$APP_DIR/Contents/Resources/AppIcon.icns"
fi

# ---------- 3. 签名 ----------
SIGN_IDENTITY="${APPLE_SIGN_IDENTITY:-}"
if [ -n "$SIGN_IDENTITY" ]; then
  echo "==> Developer ID 签名: $SIGN_IDENTITY"
  codesign --force --deep --timestamp --options runtime \
    --sign "$SIGN_IDENTITY" "$APP_DIR"
else
  echo "==> 未提供 APPLE_SIGN_IDENTITY，使用 ad-hoc 签名（仅本机可运行）"
  codesign --force --deep --sign - "$APP_DIR"
fi

# ---------- 4. 校验 ----------
echo "==> codesign -dv"
codesign -dv --verbose=4 "$APP_DIR" 2>&1 | sed 's/^/    /'
echo "==> codesign --verify --deep --strict"
codesign --verify --deep --strict "$APP_DIR" && echo "    验证通过"

echo
echo "==> spctl --assess --verbose=4（Gatekeeper；ad-hoc 会 fail，Developer ID+公证后 pass）"
if spctl --assess --verbose=4 "$APP_DIR" 2>&1; then
  echo "    Gatekeeper 通过 ✅"
else
  echo "    Gatekeeper 未通过（预期：ad-hoc 无公证；正式签名后运行 notarize.sh 再验）"
fi

echo
echo "✅ 产物: $APP_DIR"

# ---------- 5. （可选）DMG ----------
if [ "$MAKE_DMG" = true ]; then
  DMG_PATH="$DIST_DIR/$APP_NAME.dmg"
  TMP_DIR="$(mktemp -d)"
  cp -R "$APP_DIR" "$TMP_DIR/"
  echo "==> hdiutil create: $DMG_PATH"
  hdiutil create -volname "$APP_NAME" -srcfolder "$TMP_DIR" \
    -ov -format UDZO "$DMG_PATH" >/dev/null
  rm -rf "$TMP_DIR"
  echo "✅ DMG: $DMG_PATH"
fi
