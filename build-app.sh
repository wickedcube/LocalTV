#!/bin/zsh
# Builds TVUtils.app (menu bar app) next to this script.
set -e
cd "$(dirname "$0")"
APP=TVUtils.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
swiftc -swift-version 5 -O -target "$(uname -m)-apple-macos13.0" app/main.swift -o "$APP/Contents/MacOS/TVUtils"
cp server.js "$APP/Contents/Resources/"
cp -R public "$APP/Contents/Resources/public"
[ -d node_modules ] || npm install --omit=dev
cp -R node_modules "$APP/Contents/Resources/node_modules"
cat > "$APP/Contents/Info.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>NSPrincipalClass</key><string>NSApplication</string>
<key>CFBundleName</key><string>TVUtils</string>
<key>CFBundleIdentifier</key><string>local.tvutils.app</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>CFBundleExecutable</key><string>TVUtils</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSUIElement</key><true/>
<key>NSLocalNetworkUsageDescription</key><string>TVUtils needs local network access to find your TV and stream videos to it.</string>
<key>NSBonjourServices</key><array><string>_googlecast._tcp</string></array>
</dict></plist>
PL
codesign --force --sign - "$APP"
echo "Built $APP"
