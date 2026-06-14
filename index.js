import { AppRegistry, DeviceEventEmitter, Image, NativeModules } from 'react-native';
import App from './src/App';
import { name as appName } from './app.json';
import { FileUtils, PluginCommAPI, PluginFileAPI, PluginManager } from 'sn-plugin-lib';

// ─── 1. Register component ────────────────────────────────────────────────────
AppRegistry.registerComponent(appName, () => App);

// ─── 2. Color state ───────────────────────────────────────────────────────────
// _penColor / _highColor are the picker's REMEMBERED swatches (last picked),
// persisted to prefs.json so the panel opens on a sensible default. They are NOT
// applied to strokes on their own.
let _penColor  = { penColor: (0xff*0x1000000+0x23*0x10000+0x1f*0x100+0x20)|0, hex: '#231F20' };
let _highColor = { penColor: (0xff*0x1000000+0xf2*0x10000+0xc6*0x100+0xde)|0, hex: '#F2C6DE' };

// _explicitColor is the colour the user has explicitly chosen. It starts null
// (no override) and is dropped back to null when the user draws with a different
// native pen (penColor/penType/width) than the one the override was anchored to
// — i.e. they picked a different pen, so we go back to that pen's native colour.
// While it is null, new strokes are recorded with NO colour and keep their
// native pen colour at export time.
//
// Cross-note bleed is handled by _explicitNote (below), NOT by resetting on note
// load. _loadNote MUST NOT clear _explicitColor: it runs lazily from the pen_up
// handler, so a "note switch" is often detected only AFTER the user has already
// picked a colour for the note they're now on — clearing here wiped that fresh
// pick (the "first colour pick in a note doesn't apply" bug).
let _explicitColor = null;
// Native pen signature ("penColor_penType_thickness") the override is anchored
// to. Set from the first stroke drawn after a pick; null = anchor pending.
let _explicitSig = null;
// The note path the override was picked FOR. Captured (async) at pick time so a
// pick made on note B can't be applied to note A and vice-versa. null = not yet
// resolved → treat as "the current note" (covers the brief window between the
// pick and getCurrentFilePath resolving).
let _explicitNote = null;

export function getPenColor()      { return _penColor; }
export function getHighColor()     { return _highColor; }
export function getExplicitColor() { return _explicitColor; }
export function clearColor()       { _explicitColor = null; _explicitSig = null; _explicitNote = null; }

function _argb(hex) {
  const c = hex.replace('#', '');
  return (0xff * 0x1000000
    + parseInt(c.slice(0, 2), 16) * 0x10000
    + parseInt(c.slice(2, 4), 16) * 0x100
    + parseInt(c.slice(4, 6), 16)) | 0;
}

// ─── 3. Color storage — one JSON file per note ────────────────────────────────
//
// Stored via the ColorStorage native module. Layout in {exportDir}/.ccp/:
//   prefs.json                 → { pen, high }                     picker defaults
//   {noteName}_colors.json     → { byUuid, byIndex, penPrefs }     per note
//       byUuid:   { uuid: "#RRGGBB" }                 primary per-stroke key
//       byIndex:  { "page_numInPage": "#RRGGBB" }     fallback per-stroke key
//       penPrefs: { pen, high }                       fallback for un-recorded strokes
//
// ExportColorPDF reads this JSON at export time. One read on note-open, one
// write per change — no per-stroke filesystem calls.

const ColorStorage = NativeModules.ColorStorage;

let _exportDir = null;

async function _getExportDir() {
  if (!_exportDir) {
    const p = await FileUtils.getExportPath();
    _exportDir = (p || '').replace(/\/+$/, '');
  }
  return _exportDir;
}

// Same sanitization as ECP's deriveBaseName — must stay in sync.
function _sanitizeBaseName(notePath) {
  const noExt = notePath.split('/').pop().replace(/\.[^.]+$/, '');
  return noExt.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'note';
}

async function _ccpDir()             { return `${await _getExportDir()}/.ccp`; }
async function _prefsPath()          { return `${await _ccpDir()}/prefs.json`; }
async function _colorsPath(baseName) { return `${await _ccpDir()}/${baseName}_colors.json`; }

async function _readJson(path) {
  try {
    const raw = await ColorStorage.readFile(path);   // "" if the file doesn't exist
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

async function _writeJson(path, obj) {
  // ColorStorage.writeFile creates parent dirs as needed.
  try { await ColorStorage.writeFile(path, JSON.stringify(obj)); } catch {}
}

// Geometry fingerprint of a stroke — a DURABLE colour key that survives note
// editing (reorder/insert of OTHER strokes) where numInPage drifts and the uuid
// is re-minted. Depends only on this stroke's own geometry: sample-point count +
// first/last point + bbox max. MUST be computed byte-identically here and in
// ExportColorPDF's exporter.js (keep the two in sync). Read async (points live in
// native cache) — only a few reads, so cheap.
async function _strokeGeomKey(el) {
  // Durable per-stroke key. The old 5-point version COLLIDED for short strokes
  // (single letters) → colours bled between strokes. Strengthened: native pen
  // identity (penColor+penType) + point count + up to 9 evenly-spaced sample
  // points + the real bbox of those points. Two distinct strokes (different pen,
  // length, position OR size) can no longer share a key. We deliberately do NOT
  // use el.maxX/maxY — for document annotations those are the PAGE bounds
  // (15819,11864 EMR), constant. MUST match ExportColorPDF's strokeGeomKey.
  const st = el.stroke || {};
  const pc = st.penColor ?? 0, pt = st.penType ?? 0;
  const pts = st.points;
  let n = 0;
  try { n = (pts && pts.size) ? await pts.size() : 0; } catch {}
  if (n <= 0) return `${pc}_${pt}|0`;
  const STEPS = Math.min(9, n);
  const idxs = [];
  for (let k = 0; k < STEPS; k++) idxs.push(Math.round(k * (n - 1) / (STEPS - 1 || 1)));
  const coords = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let last = -1;
  for (const i of idxs) {
    if (i === last) continue; last = i;
    try {
      const p = await pts.get(i);
      if (p) {
        const x = Math.round(p.x), y = Math.round(p.y);
        coords.push(`${x},${y}`);
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    } catch {}
  }
  return `${pc}_${pt}|${n}|${coords.join(';')}|${minX},${minY},${maxX},${maxY}`;
}

// ─── 4. In-memory color map for the current note ──────────────────────────────
// The THREE maps (byGeom/byUuid/byIndex → colour hex) remain the matching data that
// ExportColorPDF reads — unchanged on disk and in spirit. `strokes` is an ADDITIVE
// per-stroke record block ({ id: {color,geom,uuid,idx} }) for traceability + pruning;
// `_idxId` is an in-memory position→id index so the recorder upserts one record per
// stroke. nextId is the running unique-id counter.
let _note = { path: null, baseName: null, byIndex: {}, byUuid: {}, byGeom: {}, strokes: {}, _idxId: {}, nextId: 1 };

async function _loadNote(notePath) {
  const baseName = _sanitizeBaseName(notePath);
  const data = await _readJson(await _colorsPath(baseName));
  const byIndex = (data && typeof data.byIndex === 'object' && data.byIndex) ? data.byIndex : {};
  const byUuid  = (data && typeof data.byUuid  === 'object' && data.byUuid)  ? data.byUuid  : {};
  const byGeom  = (data && typeof data.byGeom  === 'object' && data.byGeom)  ? data.byGeom  : {};
  const strokes = (data && typeof data.strokes === 'object' && data.strokes) ? data.strokes : {};
  // Rebuild the position→id index and the next-id counter from any loaded records.
  const _idxId = {}; let nextId = 1;
  for (const id of Object.keys(strokes)) {
    const r = strokes[id]; if (r && r.idx) _idxId[r.idx] = id;
    const n = parseInt(String(id).replace(/^k/, ''), 10); if (Number.isFinite(n) && n >= nextId) nextId = n + 1;
  }
  _note = { path: notePath, baseName, byIndex, byUuid, byGeom, strokes, _idxId, nextId };
  // Deliberately does NOT touch _explicitColor/_explicitSig. This runs lazily
  // from the pen_up handler, so resetting here would wipe a colour the user
  // legitimately just picked for the note they're now on. Cross-note isolation
  // is enforced by the _explicitNote check in _recordStrokeColors instead.
}

// Upsert the per-stroke record (one record per position, keyed by a unique id).
function _putRecord(idxKey, hex, geom, uuid) {
  let id = _note._idxId[idxKey];
  if (!id) { id = 'k' + (_note.nextId++); _note._idxId[idxKey] = id; }
  _note.strokes[id] = { color: hex, geom: geom || '', uuid: uuid || '', idx: idxKey };
}

async function _saveNote() {
  if (!_note.baseName) return;
  // No penPrefs fallback: a stroke is only ever coloured if it has its own
  // byIndex/byUuid entry. Unrecorded strokes keep their native pen colour at
  // export time (ExportColorPDF renders no-entry strokes natively).
  // v2: keep the three matching maps (ECP reads these, unchanged) + the strokes
  // record block (traceability). Old readers ignore `v`/`strokes`; ECP ignores them.
  await _writeJson(await _colorsPath(_note.baseName), {
    v: 2,
    byUuid:  _note.byUuid,
    byIndex: _note.byIndex,
    byGeom:  _note.byGeom,
    strokes: _note.strokes,
  });
}

async function _ensureNote(notePath) {
  if (_note.path !== notePath) await _loadNote(notePath);
}

// ─── 5. Prefs (picker defaults, global) ───────────────────────────────────────

async function _loadPrefs() {
  const prefs = await _readJson(await _prefsPath());
  // Restore the remembered picker swatches only — this does NOT arm an override.
  if (prefs?.pen)  _penColor  = { penColor: _argb(prefs.pen),  hex: prefs.pen };
  if (prefs?.high) _highColor = { penColor: _argb(prefs.high), hex: prefs.high };
}

async function _savePrefs() {
  await _writeJson(await _prefsPath(), { pen: _penColor.hex, high: _highColor.hex });
}

// Tag the freshly-armed override with the note that's open RIGHT NOW, so the
// pen_up handler only applies it to strokes drawn on that note. Resolved async
// (getCurrentFilePath has no sync form); the human gap between picking a colour
// and drawing the first stroke is far longer than this resolves in. Until it
// resolves, _explicitNote stays null and the override applies to the current
// note by default — correct, since the pick was just made for it.
function _tagExplicitNote() {
  PluginCommAPI.getCurrentFilePath()
    .then((r) => { if (r.success && r.result) _explicitNote = r.result; })
    .catch(() => {});
}

export function setPenColor(c) {
  _penColor = c;          // remember as the picker default
  _explicitColor = c;     // arm override…
  _explicitSig = null;    // …anchored to whichever native pen draws next
  _explicitNote = null;   // …for the current note (resolved just below)
  _tagExplicitNote();
  _savePrefs().catch(() => {});
}
export function setHighColor(c) {
  _highColor = c;
  _explicitColor = c;
  _explicitSig = null;
  _explicitNote = null;
  _tagExplicitNote();
  _savePrefs().catch(() => {});
}

// ─── 6. Init SDK ──────────────────────────────────────────────────────────────
PluginManager.init().then(() => {
  // Register the pen_up listener IMMEDIATELY — before any async I/O — so strokes
  // drawn right after opening a note aren't missed. Loads run in the background.
  PluginManager.registerEventListener('event_pen_up', 1, {
    onMsg: (elements) => {
      if (!elements?.length) return;
      _recordStrokeColors(elements).catch(() => {});
    },
  });

  (async () => {
    await _getExportDir();
    await _loadPrefs();
    const fileResp = await PluginCommAPI.getCurrentFilePath();
    if (fileResp.success && fileResp.result) {
      await _loadNote(fileResp.result);
      _reconcileSidecar(fileResp.result).catch(() => {});   // clean stale entries on entry
    }
  })().catch(() => {});
}).catch(() => {});

// pen_up: tag newly drawn strokes with the note's explicit colour — but only if
// the user has chosen one for this note. Otherwise strokes stay native.
async function _recordStrokeColors(elements) {
  // Snapshot whether an override is armed RIGHT NOW — synchronously, in pen_up
  // emission order, BEFORE any await. A stroke drawn while no override was armed
  // must never anchor the override or get recorded, even if the user picks a
  // colour during the async note lookup below.
  //
  // Why this matters: the handler parks on the await Promise.all() further down.
  // If the user lifts a native (e.g. greyscale) pen and THEN picks a plugin
  // colour, that stale pre-pick handler resumes after the pick, sees the freshly
  // armed _explicitColor with _explicitSig still null, and anchors the override
  // to the WRONG native pen's signature. The user's real coloured strokes then
  // mismatch that anchor and are dropped straight back to native — the
  // intermittent "colour doesn't apply after switching from a greyscale pen"
  // bug. Gating on the emit-time armed state stops the stale stroke cold.
  const armedAtEmit = !!_explicitColor;

  const strokes = [];   // { num, uuid, sig, geom }
  for (const el of elements) {
    if (el.type === 0 && el.stroke && el.numInPage != null) {
      // Signature = the native pen's identity: colour + type + width. Any change
      // (incl. width-only) means the user picked a different pen, so the override
      // is dropped back to native. penColor/penType are plain numbers on Stroke;
      // thickness (pen width) is a plain number on the Element — all safe to read
      // synchronously before recycle().
      const sig = `${el.stroke.penColor}_${el.stroke.penType}_${el.thickness}`;
      // Compute the durable geometry key ONLY when an override is armed (else we'd
      // read points for every native stroke for nothing). Must happen before
      // recycle(), which releases the native point cache.
      const geom = armedAtEmit ? await _strokeGeomKey(el) : '';
      strokes.push({ num: el.numInPage, uuid: el.uuid || '', sig, geom });
    }
    el.recycle?.();
  }
  // No override armed when these strokes were drawn, or nothing strokeable →
  // leave them native and, crucially, never let them touch the anchor.
  if (!armedAtEmit || strokes.length === 0) return;

  const [fileResp, pageResp] = await Promise.all([
    PluginCommAPI.getCurrentFilePath(),
    PluginCommAPI.getCurrentPageNum(),
  ]);
  if (!fileResp.success || !fileResp.result) return;

  const notePath = fileResp.result;
  const page     = (pageResp.success && pageResp.result != null) ? pageResp.result : 0;

  // Load this note's colour map (no longer resets the override — see _loadNote).
  await _ensureNote(notePath);

  // Default: no colour chosen → leave new strokes native.
  if (!_explicitColor) return;

  // Cross-note isolation: only apply the override to the note it was picked for.
  // A null _explicitNote means the tag hasn't resolved yet — the pick was just
  // made for the current note, so apply it. A mismatch means this pick belongs
  // to a different note (the user switched without re-picking) → stay native.
  if (_explicitNote && _explicitNote !== notePath) return;

  let wrote = 0;
  for (const s of strokes) {
    // Anchor the override to the first native pen it's drawn with.
    if (_explicitSig === null) _explicitSig = s.sig;
    // A different native pen (colour, type OR width) than the anchor → the user
    // picked another pen → drop the override; this and later strokes stay native.
    if (s.sig !== _explicitSig) {
      _explicitColor = null;
      _explicitSig   = null;
      break;
    }
    const idxKey = `${page}_${s.num}`;
    _note.byIndex[idxKey] = _explicitColor.hex;
    if (s.uuid) _note.byUuid[s.uuid] = _explicitColor.hex;
    if (s.geom) _note.byGeom[s.geom] = _explicitColor.hex;   // durable across edits
    _putRecord(idxKey, _explicitColor.hex, s.geom, s.uuid);  // additive per-stroke record
    wrote++;
  }
  if (wrote > 0) await _saveNote();
}

// Called by App.tsx after a lasso-recolor. tuples: {uuid, hex, page, numInPage, geom}.
export async function updateColorMapAndSave(tuples, filePath) {
  await _ensureNote(filePath);
  for (const t of tuples) {
    const idxKey = t.numInPage != null ? `${t.page}_${t.numInPage}` : null;
    if (idxKey)   _note.byIndex[idxKey] = t.hex;
    if (t.uuid)   _note.byUuid[t.uuid] = t.hex;
    if (t.geom)   _note.byGeom[t.geom] = t.hex;   // durable across edits
    if (idxKey)   _putRecord(idxKey, t.hex, t.geom, t.uuid);
  }
  await _saveNote();
}

// ─── Reconcile: drop sidecar data for strokes that no longer exist ────────────
// Runs on CCP ENTRY (note-load + Colors-panel open), BEFORE the user draws anything.
// At that moment an erased stroke's slot is still EMPTY, so the check is a simple,
// orientation-SAFE "is there a live stroke at this position?" (numInPage survives
// rotation; a merely-rotated stroke still occupies its slot, so it's never pruned).
// This stops an erased annotation's colour from being inherited by a later stroke
// that reuses its slot — and keeps the sidecar (and exports) free of stale data.
let _reconcileBusy = false;
async function _reconcileSidecar(notePath) {
  if (_reconcileBusy) return;
  _reconcileBusy = true;
  try {
    await _ensureNote(notePath);
    if (!_note.baseName) return;
    const totalResp = await PluginFileAPI.getNoteTotalPageNum(notePath);
    const total = (totalResp && totalResp.success && totalResp.result) ? totalResp.result : 0;
    if (!total) return;
    // Collect live POSITIONS (and uuids) only — cheap, no stroke-point reads. byGeom
    // is left alone on purpose: it's orientation-dependent (pruning it would need the
    // points) and a new stroke's geometry can't collide with an erased one's key, so
    // stale byGeom entries are inert. The rainbow lives entirely in byIndex (position).
    const liveIdx = new Set(), liveUuid = new Set();
    for (let p = 0; p < total; p++) {
      const r = await PluginFileAPI.getElements(p, notePath);
      const els = (r && r.success && Array.isArray(r.result)) ? r.result : [];
      for (const el of els) {
        if (el.type === 0 && el.stroke && el.numInPage != null) {
          liveIdx.add(`${p}_${el.numInPage}`);
          if (el.uuid) liveUuid.add(el.uuid);
        }
        el.recycle?.();
      }
    }
    let pIdx = 0, pUuid = 0, pRec = 0;
    for (const k of Object.keys(_note.byIndex)) if (!liveIdx.has(k))  { delete _note.byIndex[k]; pIdx++; }
    for (const k of Object.keys(_note.byUuid))  if (!liveUuid.has(k)) { delete _note.byUuid[k];  pUuid++; }
    // Drop records whose position is no longer live, and the position→id index.
    for (const id of Object.keys(_note.strokes)) {
      const rec = _note.strokes[id];
      if (!rec || !liveIdx.has(rec.idx)) { delete _note.strokes[id]; if (rec) delete _note._idxId[rec.idx]; pRec++; }
    }
    if (pIdx || pUuid || pRec) await _saveNote();
  } catch {} finally { _reconcileBusy = false; }
}
export { _reconcileSidecar };

// ─── 7. Pending button state ──────────────────────────────────────────────────
let _pendingButtonId = null;

PluginManager.registerButtonListener({
  onButtonPress: (event) => {
    _pendingButtonId = event.id;
    // Notify the (possibly already-mounted) App on every press so it re-detects
    // picker (id 10) vs lasso/recolor (id 20) mode on each open.
    DeviceEventEmitter.emit('pluginButton', { id: event.id });
    // Recolor pressed: snapshot the lasso now, before the panel collapses it.
    if (event.id === 20) _captureLasso();
    // CCP ENTRY → reconcile the sidecar (drop colours for strokes erased since last
    // time, while their slots are still empty). Fire-and-forget; only prunes dead
    // entries, so it can't disturb the lasso selection (those strokes are live).
    PluginCommAPI.getCurrentFilePath()
      .then((r) => { if (r.success && r.result) _reconcileSidecar(r.result).catch(() => {}); })
      .catch(() => {});
  },
});

export function checkPendingButton() {
  const id = _pendingButtonId;
  _pendingButtonId = null;
  return id;
}

// ─── 8. Lasso snapshot ─────────────────────────────────────────────────────────
// getLassoElements() collapses to almost nothing once the full-screen Recolor
// panel opens, so we snapshot the selection the instant Recolor (id 20) is
// pressed — while the lasso is still intact — and recolor from that snapshot.
let _lassoSnapshot = null;   // { page, strokes:[{numInPage,uuid}] }

async function _captureLasso() {
  try {
    const [pageResp, fileResp, lassoResp] = await Promise.all([
      PluginCommAPI.getCurrentPageNum(),
      PluginCommAPI.getCurrentFilePath(),
      PluginCommAPI.getLassoElements(),
    ]);
    const page     = (pageResp.success && pageResp.result != null) ? pageResp.result : 0;
    const notePath = (fileResp.success && fileResp.result) ? fileResp.result : null;

    // First pass: the numInPage span of the lassoed strokes (getLassoElements may
    // skip some interior strokes, so we only trust it for the min/max range).
    let lo = Infinity, hi = -Infinity;
    if (lassoResp.success && lassoResp.result) {
      for (const el of lassoResp.result) {
        if ((el.type === 0 || el.type === 700) && el.numInPage != null) {
          if (el.numInPage < lo) lo = el.numInPage;
          if (el.numInPage > hi) hi = el.numInPage;
        }
        el.recycle?.();
      }
    }

    // Second pass: re-read the WHOLE page and compute a durable geom key for EVERY
    // stroke in [lo,hi] — including the interior ones getLassoElements skipped. This
    // is what makes recolours durable: every recoloured stroke gets byGeom, so it
    // never depends on byIndex (now gated off in the exporter to stop colour bleed).
    const strokes = [];
    if (notePath && lo <= hi) {
      const elemsResp = await PluginFileAPI.getElements(page, notePath);
      const elems = (elemsResp.success && Array.isArray(elemsResp.result)) ? elemsResp.result : [];
      for (const el of elems) {
        if (el.type === 0 && el.numInPage != null && el.numInPage >= lo && el.numInPage <= hi) {
          const geom = await _strokeGeomKey(el);
          strokes.push({ numInPage: el.numInPage, uuid: el.uuid || '', geom });
        }
        el.recycle?.();
      }
    }
    _lassoSnapshot = { page, strokes };
  } catch {
    _lassoSnapshot = null;
  }
}

export function getLassoSnapshot() {
  const s = _lassoSnapshot;
  _lassoSnapshot = null;
  return s;
}

// ─── 9. Button registration ────────────────────────────────────────────────────
PluginManager.registerButton(1, ['NOTE', 'DOC'], {
  id: 10, name: 'Colors',
  icon: Image.resolveAssetSource(require('./assets/icon.png')).uri,
  showType: 1,
});

PluginManager.registerButton(2, ['NOTE', 'DOC'], {
  id: 20, name: 'Recolor',
  icon: Image.resolveAssetSource(require('./assets/icon.png')).uri,
  showType: 1, editDataTypes: [0],
});
