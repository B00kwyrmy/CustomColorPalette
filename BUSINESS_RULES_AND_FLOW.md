# CustomColorPalette (CCP) — Business Rules & Process Flow

## Purpose
CustomColorPalette lets the user assign **colours** to handwriting/marker strokes. The colour does **not** change the stroke on the device (the e‑ink screen is grayscale); it is recorded in a sidecar and applied **in the export** by ExportColorPDF.

One of three cooperating plugins:
- **CustomColorPalette (CCP)** — records each stroke's *colour* (this plugin).
- **MarkerSize** — records each marker's *size*.
- **ExportColorPDF (ECP)** — reads both sidecars and renders the coloured + sized export.

---

## Business Rules

1. **Native by default; colour is opt‑in.** A stroke keeps its native pen colour unless the user explicitly arms a colour. Un‑recorded strokes are never coloured at export.
2. **No stroke mutation.** CCP never modifies the note. It only writes a sidecar; the note file is untouched and the stroke stays readable in its native pen colour on screen.
3. **Two ways to colour:**
   - **Freehand (picker mode)** — arm a colour, then write; new strokes get it.
   - **Lasso (Recolor mode)** — select existing strokes, pick a colour, Apply — colours the selection retroactively.
4. **Pen‑anchor / auto‑drop (freehand).** An armed colour is anchored to the first native pen it's drawn with (signature = `penColor_penType_thickness`). The moment the user switches to a **different** native pen — any change of colour, pen type, or width — the override **drops** and strokes return to native. The user re‑opens the plugin to pick again.
5. **Cross‑note isolation.** A colour armed while note A is open is tagged to note A; it will not colour strokes drawn on note B.
6. **Per‑stroke recording, three keys.** Each coloured stroke is stored under:
   - `byGeom` — a geometry fingerprint (durable: survives editing that reorders/inserts *other* strokes),
   - `byUuid` — the stroke uuid (usually regenerated each read, so rarely matches — kept for completeness),
   - `byIndex` = `"page_numInPage"` — orientation‑independent position fallback.
7. **Highlighter vs regular colours.** The palette has regular ink colours and six light "Highlighter …" shades. The recorded value is just the hex; ExportColorPDF decides rendering (highlighter shades → translucent wash; regular colours → opaque).
8. **Durable geometry key.** The fingerprint is designed to survive note editing so a recorded colour keeps matching its stroke after the page changes.
9. **Picker defaults persist.** The last‑picked pen colour and highlighter colour are remembered (in `prefs.json`) so the panel opens on a sensible default — this does **not** arm an override on its own.
10. **Stale entries are pruned on note entry ("reconcile" / dead‑wood clearing).** Each time a note is opened — and when the **Colors** button is pressed — CCP drops any sidecar entry whose stroke no longer exists (colours orphaned by **erased** strokes). It runs *before* new ink is drawn, while the erased slot is still empty, so a freshly‑written stroke that reuses an erased stroke's `numInPage` position can never inherit the old colour. This is what prevents the **"rainbow word"** — a single‑colour word that, after an erase‑and‑rewrite, would otherwise export in several leftover colours. It is **orientation‑safe**: a stroke that merely rotated (e.g. a landscape→portrait export) is still live at its position and is never pruned. Only `byIndex` / `byUuid` (and the internal stroke records) are cleared; `byGeom` is left alone — a new stroke can't collide with an erased one's geometry key.

---

## Data Written
- Per note: `{EXPORT}/.ccp/{base}_colors.json`
  ```json
  { "byGeom":  { "<geomKey>": "#RRGGBB" },
    "byUuid":  { "<uuid>":    "#RRGGBB" },
    "byIndex": { "<page>_<numInPage>": "#RRGGBB" } }
  ```
- Global: `{EXPORT}/.ccp/prefs.json` → `{ "pen": "#…", "high": "#…" }` (remembered picker swatches).

---

## Process Flow

### A. Freehand colouring
```
User taps "Colors" button  ──►  full-screen palette (App.tsx)
        │
        ▼
Pick a colour  ──►  setPenColor(c) / setHighColor(c)
        • arms _explicitColor
        • clears the anchor (_explicitSig = null) — anchors to the NEXT pen
        • tags the current note (_explicitNote)
        │
        ▼
User writes  ──►  event_pen_up  ──►  _recordStrokeColors(elements)
        • snapshot "was a colour armed?" synchronously
        • anchor to the first stroke's pen signature
        • if a later stroke has a DIFFERENT signature → drop the override
        • else record colour under byGeom / byUuid / byIndex
        • save {EXPORT}/.ccp/{base}_colors.json
```

### B. Lasso recolour
```
User lassoes strokes, taps "Recolor"  ──►  _captureLasso() snapshots the selection
        │                                    (numInPage range + per-stroke geom keys)
        ▼
Panel opens in "lasso" mode  ──►  pick a colour  ──►  "Apply & Close"
        │
        ▼
updateColorMapAndSave(tuples, notePath)
        • write the colour for each selected stroke (byGeom/byUuid/byIndex)
        • save sidecar; remove the lasso; close
```

### C. Export (handled by ExportColorPDF)
```
ECP reads {EXPORT}/.ccp/{base}_colors.json
        │
        ▼
For each stroke, resolve colour: byGeom → byUuid → byIndex (position fallback)
        │
        ▼
Draw the stroke in that colour (opaque pen / translucent marker wash).
Strokes with no record stay native.
```

### D. Reconcile (dead‑wood clearing) — on note entry
```
Note opens / "Colors" button  ──►  _reconcileSidecar(notePath)
        • list the live stroke positions across every page
        • drop byIndex / byUuid entries (and stroke records) whose
          position has no live stroke  ← colours left by ERASED strokes
        • byGeom left untouched; runs BEFORE new ink, so a reused
          position can't inherit a ghost colour  ("rainbow word" fix)
        • save the pruned sidecar (only if something was removed)
```

---

## What CCP does **not** do
- It does not change colours on the device screen (grayscale e‑ink).
- It does not modify, delete, or re‑order strokes.
- It does not record stroke *size* (MarkerSize does).
- It does not render the export (ExportColorPDF does).

## Buttons
- **"Colors"** (sidebar) — opens the palette in picker mode (freehand).
- **"Recolor"** (lasso toolbar) — opens the palette in lasso mode to recolour a selection.
