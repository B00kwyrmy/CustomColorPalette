import { AppRegistry, DeviceEventEmitter, Image, NativeModules } from 'react-native';
import App from './src/App';
import { name as appName } from './app.json';
import { FileUtils, PluginCommAPI, PluginManager } from 'sn-plugin-lib';

// ─── 1. Register component ────────────────────────────────────────────────────
AppRegistry.registerComponent(appName, () => App);

// ─── 2. Active color state ────────────────────────────────────────────────────
let _penColor  = { penColor: (0xff*0x1000000+0x23*0x10000+0x1f*0x100+0x20)|0, hex: '#231F20' };
let _highColor = { penColor: (0xff*0x1000000+0xf2*0x10000+0xc6*0x100+0xde)|0, hex: '#F2C6DE' };

// Single active color: whatever the user last picked is applied to subsequent
// strokes. ExportColorPDF decides pen-tint vs highlighter-wash at export time.
let _activeColor = _penColor;

export function getPenColor()  { return _penColor; }
export function getHighColor() { return _highColor; }

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

// ─── 4. In-memory color map for the current note ──────────────────────────────
let _note = { path: null, baseName: null, byIndex: {}, byUuid: {} };

async function _loadNote(notePath) {
  const baseName = _sanitizeBaseName(notePath);
  const data = await _readJson(await _colorsPath(baseName));
  const byIndex = (data && typeof data.byIndex === 'object' && data.byIndex) ? data.byIndex : {};
  const byUuid  = (data && typeof data.byUuid  === 'object' && data.byUuid)  ? data.byUuid  : {};
  _note = { path: notePath, baseName, byIndex, byUuid };
}

async function _saveNote() {
  if (!_note.baseName) return;
  await _writeJson(await _colorsPath(_note.baseName), {
    byUuid:   _note.byUuid,
    byIndex:  _note.byIndex,
    penPrefs: { pen: _penColor.hex, high: _highColor.hex },
  });
}

async function _ensureNote(notePath) {
  if (_note.path !== notePath) await _loadNote(notePath);
}

// ─── 5. Prefs (picker defaults, global) ───────────────────────────────────────

async function _loadPrefs() {
  const prefs = await _readJson(await _prefsPath());
  if (prefs?.pen)  { _penColor  = { penColor: _argb(prefs.pen),  hex: prefs.pen };  _activeColor = _penColor; }
  if (prefs?.high) { _highColor = { penColor: _argb(prefs.high), hex: prefs.high }; }
}

async function _savePrefs() {
  await _writeJson(await _prefsPath(), { pen: _penColor.hex, high: _highColor.hex });
}

export function setPenColor(c) {
  _penColor = c;
  _activeColor = c;
  _savePrefs().catch(() => {});
}
export function setHighColor(c) {
  _highColor = c;
  _activeColor = c;
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
    if (fileResp.success && fileResp.result) await _loadNote(fileResp.result);
  })().catch(() => {});
}).catch(() => {});

// pen_up: record the active color for each newly drawn stroke.
async function _recordStrokeColors(elements) {
  const strokes = [];   // { num, uuid }
  for (const el of elements) {
    if (el.type === 0 && el.stroke && el.numInPage != null) {
      strokes.push({ num: el.numInPage, uuid: el.uuid || '' });
    }
    el.recycle?.();
  }
  if (strokes.length === 0) return;

  const [fileResp, pageResp] = await Promise.all([
    PluginCommAPI.getCurrentFilePath(),
    PluginCommAPI.getCurrentPageNum(),
  ]);
  if (!fileResp.success || !fileResp.result) return;

  const notePath = fileResp.result;
  const page     = (pageResp.success && pageResp.result != null) ? pageResp.result : 0;

  await _ensureNote(notePath);
  for (const s of strokes) {
    _note.byIndex[`${page}_${s.num}`] = _activeColor.hex;
    if (s.uuid) _note.byUuid[s.uuid] = _activeColor.hex;
  }
  await _saveNote();
}

// Called by App.tsx after a lasso-recolor. tuples: {uuid, hex, page, numInPage}.
export async function updateColorMapAndSave(tuples, filePath) {
  await _ensureNote(filePath);
  for (const t of tuples) {
    if (t.numInPage != null) _note.byIndex[`${t.page}_${t.numInPage}`] = t.hex;
    if (t.uuid)              _note.byUuid[t.uuid] = t.hex;
  }
  await _saveNote();
}

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
    const [pageResp, lassoResp] = await Promise.all([
      PluginCommAPI.getCurrentPageNum(),
      PluginCommAPI.getLassoElements(),
    ]);
    const page = (pageResp.success && pageResp.result != null) ? pageResp.result : 0;
    const strokes = [];
    if (lassoResp.success && lassoResp.result) {
      for (const el of lassoResp.result) {
        if (el.type === 0 || el.type === 700) strokes.push({ numInPage: el.numInPage ?? 0, uuid: el.uuid || '' });
        el.recycle?.();
      }
    }
    // getLassoElements drops some interior strokes (e.g. returns 57,59 but skips
    // 58). A lassoed word's strokes are a contiguous numInPage span (draw order),
    // so fill the gaps between min and max so the whole word recolors.
    if (strokes.length >= 2) {
      const nums = strokes.map(s => s.numInPage);
      const lo = Math.min(...nums), hi = Math.max(...nums);
      const have = new Set(nums);
      for (let n = lo; n <= hi; n++) if (!have.has(n)) strokes.push({ numInPage: n, uuid: '' });
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
