// ─────────────────────────────────────────────────────────────────────────────
// DIAGNOSTIC / VERBOSE-LOGGING VARIANT of CustomColorPalette/index.js.
// NOT the release build. To debug a future issue, copy this over ../index.js
// (and diagnostics/App.tsx over ../src/App.tsx), rebuild, and reinstall.
// Adds: [CCP] console.logs, pen_up RAW dump, and a pullable recolor trace at
// {EXPORT}/.ccp/recolor_debug.txt (logged on every recolor + lasso snapshot).
// Pull with: adb pull /storage/emulated/0/EXPORT/.ccp/recolor_debug.txt
// ─────────────────────────────────────────────────────────────────────────────
import { AppRegistry, DeviceEventEmitter, Image, NativeModules } from 'react-native';
import App from './src/App';
import { name as appName } from './app.json';
import { FileUtils, PluginCommAPI, PluginManager } from 'sn-plugin-lib';

// ─── 1. Register component ────────────────────────────────────────────────────
AppRegistry.registerComponent(appName, () => App);

// ─── 2. Active color state ────────────────────────────────────────────────────
let _penColor  = { penColor: (0xff*0x1000000+0x23*0x10000+0x1f*0x100+0x20)|0, hex: '#231F20' };
let _highColor = { penColor: (0xff*0x1000000+0xf2*0x10000+0xc6*0x100+0xde)|0, hex: '#F2C6DE' };

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
const ColorStorage = NativeModules.ColorStorage;

let _exportDir = null;

async function _getExportDir() {
  if (!_exportDir) {
    const p = await FileUtils.getExportPath();
    _exportDir = (p || '').replace(/\/+$/, '');
  }
  return _exportDir;
}

function _sanitizeBaseName(notePath) {
  const noExt = notePath.split('/').pop().replace(/\.[^.]+$/, '');
  return noExt.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'note';
}

async function _ccpDir()             { return `${await _getExportDir()}/.ccp`; }
async function _prefsPath()          { return `${await _ccpDir()}/prefs.json`; }
async function _colorsPath(baseName) { return `${await _ccpDir()}/${baseName}_colors.json`; }

async function _readJson(path) {
  try {
    const raw = await ColorStorage.readFile(path);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

async function _writeJson(path, obj) {
  try { await ColorStorage.writeFile(path, JSON.stringify(obj)); } catch (e) {
    console.log(`[CCP] write failed ${path}: ${e}`);
  }
}

// ─── 4. In-memory color map for the current note ──────────────────────────────
let _note = { path: null, baseName: null, byIndex: {}, byUuid: {} };

async function _loadNote(notePath) {
  const baseName = _sanitizeBaseName(notePath);
  const data = await _readJson(await _colorsPath(baseName));
  const byIndex = (data && typeof data.byIndex === 'object' && data.byIndex) ? data.byIndex : {};
  const byUuid  = (data && typeof data.byUuid  === 'object' && data.byUuid)  ? data.byUuid  : {};
  _note = { path: notePath, baseName, byIndex, byUuid };
  console.log(`[CCP] note loaded: ${baseName} (byIndex=${Object.keys(byIndex).length} byUuid=${Object.keys(byUuid).length})`);
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
  console.log(`[CCP] prefs loaded: pen=${_penColor.hex} high=${_highColor.hex}`);
}

async function _savePrefs() {
  await _writeJson(await _prefsPath(), { pen: _penColor.hex, high: _highColor.hex });
}

export function setPenColor(c) {
  _penColor = c;
  _activeColor = c;
  console.log(`[CCP] color selected (pen): ${c.hex}`);
  _savePrefs().catch(() => {});
}
export function setHighColor(c) {
  _highColor = c;
  _activeColor = c;
  console.log(`[CCP] color selected (highlighter): ${c.hex}`);
  _savePrefs().catch(() => {});
}

// ─── 6. Init SDK ──────────────────────────────────────────────────────────────
PluginManager.init().then(() => {
  console.log('[CCP] init — registering pen_up listener');

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
  const penTypes = [];
  const raw = [];       // diagnostic: every element this pen_up delivered, pre-filter
  for (const el of elements) {
    raw.push(`t${el.type}${el.stroke ? '/pt' + (el.stroke.penType ?? '?') : ''}${el.uuid ? '' : '/nouuid'}`);
    if (el.type === 0 && el.stroke && el.numInPage != null) {
      strokes.push({ num: el.numInPage, uuid: el.uuid || '' });
      penTypes.push(el.stroke.penType ?? -1);
    }
    el.recycle?.();
  }
  console.log(`[CCP] pen_up RAW: ${elements.length} el(s) → [${raw.join(' ')}]`);
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

  console.log(`[CCP] pen_up: ${strokes.length} stroke(s) page=${page} color=${_activeColor.hex} penTypes=[${penTypes.join(',')}] uuids=[${strokes.map(s => s.uuid.slice(0,8)).join(',')}]`);
}

// Called by diagnostics/App.tsx after a lasso-recolor. tuples: {uuid,hex,page,numInPage}.
export async function updateColorMapAndSave(tuples, filePath, dbg) {
  await _ensureNote(filePath);
  let n = 0;
  for (const t of tuples) {
    if (t.numInPage != null) _note.byIndex[`${t.page}_${t.numInPage}`] = t.hex;
    if (t.uuid)              _note.byUuid[t.uuid] = t.hex;
    n++;
  }
  await _saveNote();
  console.log(`[CCP] lasso recolor: ${n} stroke(s) → ${tuples[0]?.hex}`);

  // Persistent, pullable recolor log (logcat rolls over).
  try {
    const ccpDir = await _ccpDir();
    const prev = await _readJsonRaw(`${ccpDir}/recolor_debug.txt`);
    const line =
      `${new Date().toISOString()} ${_note.baseName} page=${dbg?.page} → ${dbg?.label} ${dbg?.color}\n` +
      `  lasso raw (type/numInPage/uuid?): [${(dbg?.raw || []).join(' ')}]\n` +
      `  wrote keys: [${tuples.map(t => `${t.page}_${t.numInPage}`).join(' ')}]\n`;
    await ColorStorage.writeFile(`${ccpDir}/recolor_debug.txt`, (prev || '') + line);
  } catch (e) { console.log(`[CCP] recolor_debug write failed: ${e}`); }
}

async function _readJsonRaw(path) {
  try { return await ColorStorage.readFile(path); } catch { return ''; }
}

// Append one line to the pullable recolor trace.
export async function recolorLog(line) {
  try {
    const ccpDir = await _ccpDir();
    const prev = await _readJsonRaw(`${ccpDir}/recolor_debug.txt`);
    await ColorStorage.writeFile(`${ccpDir}/recolor_debug.txt`, `${prev || ''}${new Date().toISOString()} ${line}\n`);
  } catch (e) { console.log(`[CCP] recolorLog failed: ${e}`); }
}

// ─── 7. Pending button state ──────────────────────────────────────────────────
let _pendingButtonId = null;

PluginManager.registerButtonListener({
  onButtonPress: (event) => {
    _pendingButtonId = event.id;
    DeviceEventEmitter.emit('pluginButton', { id: event.id });
    if (event.id === 20) _captureLasso();
  },
});

export function checkPendingButton() {
  const id = _pendingButtonId;
  _pendingButtonId = null;
  return id;
}

// ─── 8. Lasso snapshot ─────────────────────────────────────────────────────────
let _lassoSnapshot = null;   // { page, strokes:[{numInPage,uuid}], count }

async function _captureLasso() {
  try {
    const [pageResp, lassoResp] = await Promise.all([
      PluginCommAPI.getCurrentPageNum(),
      PluginCommAPI.getLassoElements(),
    ]);
    const page = (pageResp.success && pageResp.result != null) ? pageResp.result : 0;
    const strokes = [];
    const count = lassoResp.result?.length ?? 0;
    if (lassoResp.success && lassoResp.result) {
      for (const el of lassoResp.result) {
        if (el.type === 0 || el.type === 700) strokes.push({ numInPage: el.numInPage ?? 0, uuid: el.uuid || '' });
        el.recycle?.();
      }
    }
    let filled = 0;
    if (strokes.length >= 2) {
      const nums = strokes.map(s => s.numInPage);
      const lo = Math.min(...nums), hi = Math.max(...nums);
      const have = new Set(nums);
      for (let n = lo; n <= hi; n++) if (!have.has(n)) { strokes.push({ numInPage: n, uuid: '' }); filled++; }
    }
    _lassoSnapshot = { page, strokes, count };
    recolorLog(`SNAPSHOT @button-press: page=${page} getLasso count=${count} recordable+filled=${strokes.length} (filled ${filled}) nums=[${strokes.map(s => s.numInPage).sort((a, b) => a - b).join(',')}]`).catch(() => {});
  } catch (e) {
    _lassoSnapshot = null;
    recolorLog(`SNAPSHOT failed: ${e}`).catch(() => {});
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
