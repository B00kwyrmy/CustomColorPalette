# CustomColorPalette — diagnostic build

This folder preserves the **verbose-logging** version of the plugin's JS, kept
for debugging future issues. The files in the project root (`index.js`,
`src/App.tsx`) are the **clean release**; these are NOT built or bundled (nothing
imports them).

## What the diagnostic build adds
- `[CCP] …` console logs (view with `adb logcat -d -s ReactNativeJS:V`).
- `pen_up RAW` dump of every element each pen-up delivers (type/penType/uuid).
- A persistent, pullable recolor trace at `{EXPORT}/.ccp/recolor_debug.txt`
  (logged on every Recolor: the lasso snapshot + the keys written). Logcat rolls
  over, so this file is the reliable record. Pull it with:
  `adb pull /storage/emulated/0/EXPORT/.ccp/recolor_debug.txt`

## To enable (debugging)
Copy BOTH files over the release ones (they're a matched pair — the diagnostic
`App.tsx` calls `recolorLog`, which only the diagnostic `index.js` exports):

```
cp diagnostics/index.js index.js
cp diagnostics/App.tsx  src/App.tsx
bash buildPlugin.sh
adb push build/outputs/CustomColorPalette.snplg /storage/emulated/0/MyStyle/
# reinstall on device, then export/recolor and pull recolor_debug.txt
```

## To return to the clean release
Restore `index.js` and `src/App.tsx` from version control (or re-apply the clean
versions) and rebuild. The only differences are logging — no behavior changes.
