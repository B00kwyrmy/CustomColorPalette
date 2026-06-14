# CustomColorPalette (CCP) — Programming Details

Technical reference: file layout, what each piece of code does, the SDK calls used, and the build.

---

## Project layout
```
CustomColorPalette/
├── index.js                          ← entry: colour state, pen_up recording, lasso, sidecar I/O, buttons
├── src/App.tsx                       ← the colour palette UI (picker + lasso modes)
├── app.json / PluginConfig.json      ← pluginKey "CustomColorPalette", pluginID, reactPackages
├── buildPlugin.sh                    ← bundle JS + build native APK → CustomColorPalette.snplg
├── assets/icon.png
└── android/app/src/main/java/com/customcolorpalette/
    ├── MainApplication.kt            ← registers ColorStoragePackage
    ├── MainActivity.kt               ← getMainComponentName() = "CustomColorPalette"
    ├── ColorStorageModule.kt          ← native readFile/writeFile (getName "ColorStorage")
    └── ColorStoragePackage.kt
```

---

## `index.js` — what each part does

### Remembered swatches (picker defaults)
- `_penColor`, `_highColor` — last-picked ink / highlighter swatches. Persisted to `prefs.json`. **Not** an override on their own.
- `getPenColor()` / `getHighColor()` — read for the UI.
- `_argb(hex)` — hex → signed 32-bit ARGB int.

### Override state (the armed colour)
- `_explicitColor` — the colour the user explicitly chose, or `null` (no override → native).
- `_explicitSig` — the native pen signature (`penColor_penType_thickness`) the override is anchored to. `null` = anchor pending (set by the first stroke after a pick).
- `_explicitNote` — the note path the pick was made for (cross-note isolation). Resolved async via `_tagExplicitNote()`.
- `getExplicitColor()` / `clearColor()` — read / clear all three.
- `setPenColor(c)` / `setHighColor(c)` — arm the override: set `_explicitColor`, clear `_explicitSig` (anchor next pen), clear `_explicitNote` then `_tagExplicitNote()`, save prefs.
- `_tagExplicitNote()` — `PluginCommAPI.getCurrentFilePath()` → sets `_explicitNote`.

### Sidecar I/O
- `ColorStorage = NativeModules.ColorStorage` — native file read/write.
- `_getExportDir()` → caches `FileUtils.getExportPath()`.
- `_sanitizeBaseName(notePath)` — sanitised filename (**must match ECP `deriveBaseName`**).
- `_ccpDir()` → `{EXPORT}/.ccp`; `_prefsPath()` → `.ccp/prefs.json`; `_colorsPath(base)` → `.ccp/{base}_colors.json`.
- `_readJson(path)` / `_writeJson(path, obj)` — via `ColorStorage.readFile/writeFile`.
- `_note = { path, baseName, byIndex, byUuid, byGeom }` — current note's colour map.
- `_loadNote(notePath)` — load the colour sidecar. **Deliberately does NOT reset `_explicitColor`** (it runs lazily from pen_up; resetting here wiped a just-made pick — cross-note isolation is handled by `_explicitNote` instead).
- `_saveNote()` — write `{byUuid, byIndex, byGeom}`.
- `_ensureNote(notePath)` — reload when the note changes.
- `_loadPrefs()` / `_savePrefs()` — picker-default persistence.

### Geometry fingerprint
- `_strokeGeomKey(el)` — async. `"{penColor}_{penType}|{n}|{≤9 sample points}|{bbox}"` (with consecutive-index dedup). **Byte-identical to ECP `strokeGeomKey` and MarkerSize `_strokeGeomKey`.**

### Freehand recording (pen_up)
- Listener registered in `init()`: `registerEventListener('event_pen_up', 1, { onMsg })` → `_recordStrokeColors`.
- `_recordStrokeColors(elements)`:
  1. `armedAtEmit = !!_explicitColor` snapshotted **synchronously** (so a stroke drawn while nothing was armed can never anchor/record — fixes a race where a stale handler resumes after a pick).
  2. For each stroke build `sig = penColor_penType_thickness`; compute `geom` only when armed (before `recycle()`).
  3. Resolve note/page; if `_explicitNote` ≠ current note → return (isolation).
  4. Anchor: first stroke sets `_explicitSig`. A stroke with a different sig → drop the override (`clearColor`) and stop.
  5. Record `byIndex["page_num"]`, `byUuid[uuid]`, `byGeom[geom]` = `_explicitColor.hex`; `_saveNote()`.

### Lasso recolour
- `registerButtonListener({ onButtonPress })` — stores `_pendingButtonId`, emits `DeviceEventEmitter 'pluginButton'`; on **id 20 (Recolor)** calls `_captureLasso()` immediately (the live lasso collapses once the full-screen panel opens).
- `_captureLasso()` — snapshots the lassoed strokes: the `numInPage` span (from `getLassoElements`) then re-reads the whole page (`PluginFileAPI.getElements`) to compute a durable `geom` for **every** stroke in that span (including ones the lasso skipped).
- `getLassoSnapshot()` — consumed by `App.tsx`.
- `updateColorMapAndSave(tuples, filePath)` — write `byIndex/byUuid/byGeom` for each selected stroke; `_saveNote()`.
- `checkPendingButton()` — App.tsx reads which button opened the panel (pending-button-id pattern, avoids a timing gap).

### Buttons
- `registerButton(1, ['NOTE','DOC'], { id:10, name:'Colors', showType:1 })` — picker.
- `registerButton(2, ['NOTE','DOC'], { id:20, name:'Recolor', showType:1, editDataTypes:[0] })` — lasso toolbar.

---

## `src/App.tsx` — the UI
- `INK_COLORS` + `HIGHLIGHT_COLORS` → one combined `COLORS` list, laid out in two columns.
- `mode` = `'picker'` | `'lasso'`, chosen from `checkPendingButton()` (id 10 vs 20) + a `'pluginButton'` listener.
- **Picker mode:** tapping a colour arms it (`setPenColor`/`setHighColor`).
- **Lasso mode:** tapping selects; "Apply & Close" calls `applyLassoRecolor(color)` → `updateColorMapAndSave(tuples, notePath)`, then `setLassoBoxState(2)` (remove lasso) + `closePluginView()`.
- `onHeaderPress` re-commits the shown colour on close (so the checkmarked colour applies without re-tapping).

---

## Native module (`ColorStorageModule.kt`)
- `getName() = "ColorStorage"`; `@ReactMethod writeFile/readFile` (mkdirs + writeText / read-or-empty). Wrapped by `ColorStoragePackage`, registered in `MainApplication`.

---

## SDK calls used
| Call | Why |
|---|---|
| `registerEventListener('event_pen_up', …)` | record freshly drawn strokes |
| `registerButton(1/2, …)` + `registerButtonListener` | Colors / Recolor buttons + routing |
| `PluginCommAPI.getCurrentFilePath()` / `getCurrentPageNum()` | note/page of a stroke |
| `PluginCommAPI.getLassoElements()` | the lassoed selection (snapshotted on Recolor) |
| `PluginCommAPI.setLassoBoxState(2)` | remove the lasso after applying |
| `PluginFileAPI.getElements(page, notePath)` | re-read the page for durable lasso geom keys |
| `el.stroke.points` accessor | sample points for the geom key |
| `FileUtils.getExportPath()` + `NativeModules.ColorStorage` | sidecar persistence |

---

## Build & packaging
- `buildPlugin.sh` → Metro bundle + native APK → `CustomColorPalette.snplg`.
- **Not minified** — CCP is intentionally left on the original (un-R8'd) build to avoid any risk to its hard-won colour-matching logic. (MarkerSize and ExportColorPDF are minified; CCP is not.)

---

## Key invariants (don't break)
1. `_strokeGeomKey` ≡ ECP `strokeGeomKey` ≡ MarkerSize `_strokeGeomKey` (byte-for-byte).
2. `_sanitizeBaseName` ≡ ECP `deriveBaseName`.
3. Sidecar shape `{byUuid, byIndex, byGeom}` at `{EXPORT}/.ccp/{base}_colors.json` is the contract ECP reads.
4. Never mutate strokes; never write into `penColor` on the note (the device renders penColor as grey → would change the on-screen look).
5. The synchronous `armedAtEmit` snapshot and the `_explicitNote` isolation are race fixes — keep them.
