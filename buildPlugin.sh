#!/usr/bin/env bash
# Build CustomColorPalette.snplg
set -e
echo "Installing dependencies…"
npm install
echo "Building plugin…"
npx react-native bundle \
  --platform android \
  --dev false \
  --entry-file index.js \
  --bundle-output build/outputs/index.android.bundle \
  --assets-dest build/outputs/res
mkdir -p build/outputs
cp PluginConfig.json build/outputs/
cd build/outputs
zip -r "CustomColorPalette.snplg" . -x "*.snplg"
echo "Done → build/outputs/CustomColorPalette.snplg"
