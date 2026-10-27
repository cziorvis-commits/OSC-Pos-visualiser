#!/bin/bash
# Builds dist/OSC Visualiser.app: a menu bar app that runs the bridge without a terminal.
# Usage: npm run app   (needs Xcode or the Command Line Tools)
set -euo pipefail
cd "$(dirname "$0")/.."

APP="dist/OSC Visualiser.app"
VERSION=$(node -p "require('./package.json').version")
BUILD=$(mktemp -d)
trap 'rm -rf "$BUILD"' EXIT

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/app"

echo "Compiling (Apple silicon + Intel)…"
for arch in arm64 x86_64; do
  xcrun --sdk macosx swiftc -O -swift-version 5 -target "$arch-apple-macos13.0" \
    macos/main.swift -o "$BUILD/$arch"
done
lipo -create "$BUILD/arm64" "$BUILD/x86_64" -output "$APP/Contents/MacOS/OSC Visualiser"

echo "Bundling the bridge and UI…"
cp -R bridge public package.json config.json "$APP/Contents/Resources/app/"
sed "s/VERSION/$VERSION/g" macos/Info.plist > "$APP/Contents/Info.plist"

echo "Drawing the icon…"
xcrun swift macos/make-icon.swift "$BUILD/AppIcon.iconset"
iconutil -c icns "$BUILD/AppIcon.iconset" -o "$APP/Contents/Resources/AppIcon.icns"

# Ad-hoc signature: enough for this Mac to run it and remember its Local Network permission.
codesign --force --deep --sign - "$APP"

echo "Built $APP"
echo "Drag it to Applications, or double-click it here. It lives in the menu bar."
