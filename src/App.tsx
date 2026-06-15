import React, { useEffect, useState } from 'react';
import {
  DeviceEventEmitter,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { PluginCommAPI, PluginManager } from 'sn-plugin-lib';
import { checkPendingButton, getExplicitColor, setPenColor, setHighColor, updateColorMapAndSave, getLassoSnapshot } from '../index';

// ─── Color palette ───────────────────────────────────────────────────────────
//
// penColor is a 32-bit signed int stored in the note file (Java writeInt).
// The built-in PDF renderer maps values 0-255 to grayscale ink density.
// Values outside 0-255 (i.e. full ARGB ints) are stored intact and readable
// by getElements / getLassoElements — the ExportColorPDF plugin reads them
// back and renders actual colors.  On screen and in the built-in PDF export
// these strokes render as a gray shade derived from the low byte.
//
// Format: (0xFF << 24) | (R << 16) | (G << 8) | B  — signed 32-bit.
//
// One combined list: inks + greys, then the highlighter colors (labelled
// "Highlighter <name>").  `isHighlight` routes the colour to the correct
// fallback pref bucket and lets ExportColorPDF treat the stroke as a
// translucent highlighter wash.  Which rendering a stroke actually gets is
// still decided at export time by the stroke's real penType (set by the native
// Supernote pen the user drew with) — this plugin only chooses the colour.

interface ColorEntry {
  label:       string;
  penColor:    number;   // signed 32-bit ARGB stored in stroke.penColor
  hex:         string;   // display hex for the swatch
  isHighlight: boolean;  // true = highlighter colour (routes to high pref)
}

function argb(hex: string): number {
  const c = hex.replace('#', '');
  const r = parseInt(c.slice(0,2), 16);
  const g = parseInt(c.slice(2,4), 16);
  const b = parseInt(c.slice(4,6), 16);
  return (0xff * 0x1000000 + r * 0x10000 + g * 0x100 + b) | 0;
}

const ink = (label: string, hex: string): ColorEntry =>
  ({ label, hex, penColor: argb(hex), isHighlight: false });

const highlight = (name: string, hex: string): ColorEntry =>
  ({ label: `Highlighter ${name}`, hex, penColor: argb(hex), isHighlight: true });

// Ink / pen colours — used by Ink Pen, Needle Point, Calligraphy, Marker.
const INK_COLORS: ColorEntry[] = [
  ink('Light Grey', '#C9C9C9'),
  ink('Dark Grey',  '#9D9D9D'),
  ink('Black',      '#231F20'),
  ink('Blue',       '#0033A0'),
  ink('Red',        '#BF062F'),
  ink('Pink',       '#CD6FBD'),
  ink('Orange',     '#FF8200'),
  ink('Green',      '#007B5F'),
  ink('Lime',       '#00FF00'),
  ink('Purple',     '#763AC7'),
];

// Highlighter colours — light washes meant to show script through them.
// Lt/Dk Grey intentionally REUSE the grey ink hexes: wash-vs-opaque is decided by
// pen type, so the same hex reads opaque on an ink pen and translucent on the
// marker. (Resized markers also need these hexes in ExportColorPDF's
// HIGHLIGHTER_HEXES — added in phase 2.)
const HIGHLIGHT_COLORS: ColorEntry[] = [
  highlight('Lt Grey', '#C9C9C9'),
  highlight('Dk Grey', '#9D9D9D'),
  highlight('Pink',   '#F2C6DE'),
  highlight('Orange', '#F7D9C4'),
  highlight('Yellow', '#FAEDCB'),
  highlight('Green',  '#C9E4DE'),
  highlight('Blue',   '#C6DEF1'),
  highlight('Purple', '#DBCDF0'),
];

// Single combined list shown in both the picker and the recolor panel.
const COLORS: ColorEntry[] = [...INK_COLORS, ...HIGHLIGHT_COLORS];

// Explicit two-column layout (column-major) so each colour sits where intended.
const byLabel = (label: string): ColorEntry =>
  COLORS.find(c => c.label === label) as ColorEntry;

const LEFT_COLUMN: ColorEntry[] = [
  'Light Grey', 'Dark Grey', 'Black', 'Blue', 'Red', 'Pink', 'Orange',
  'Green', 'Lime', 'Purple',
].map(byLabel);

const RIGHT_COLUMN: ColorEntry[] = [
  'Highlighter Lt Grey', 'Highlighter Dk Grey',
  'Highlighter Pink', 'Highlighter Orange', 'Highlighter Yellow',
  'Highlighter Green', 'Highlighter Blue', 'Highlighter Purple',
].map(byLabel);

type Mode = 'picker' | 'lasso';

// ─── Component ────────────────────────────────────────────────────────────────

export default function App(): React.JSX.Element {
  const [mode, setMode] = useState<Mode>('picker');
  // null = no override: new strokes keep their native pen colour. Initialise from
  // THIS note's explicit pick (null on a fresh/untouched note) so reopening the
  // panel honestly reflects what's actually being applied.
  const [selected, setSelected] = useState<ColorEntry | null>(() => getExplicitColor());
  const [status, setStatus] = useState('');
  const [busy,   setBusy]   = useState(false);

  useEffect(() => {
    const handleButton = (id: number | null) => {
      if (id === 20) {
        setMode('lasso');
        setStatus('Tap a colour, then “Apply & Close” to recolor the selection.');
      } else {
        setMode('picker');
        setStatus('Choose a colour. New strokes will use it automatically.');
      }
    };
    handleButton(checkPendingButton());
    const sub = DeviceEventEmitter.addListener('pluginButton', ({ id }: { id: number }) => {
      checkPendingButton(); handleButton(id);
    });
    return () => sub.remove();
  }, []);

  // Tapping a colour SELECTS it. In picker mode that's all that's needed (new
  // strokes use it). In lasso mode the user then taps "Apply & Close" to
  // actually recolor the selection.
  const selectColor = (c: ColorEntry) => {
    if (busy) return;
    setSelected(c);
    if (mode === 'lasso') {
      // Recolor is purely retroactive: it applies ONLY to the lassoed selection
      // (via applyLassoRecolor → updateColorMapAndSave). It must NOT arm the
      // freehand override, so we deliberately skip setPenColor/setHighColor here.
      setStatus(`${c.label} selected — tap “Apply & Close” to recolor the selection.`);
    } else {
      // Picker mode: arm the freehand override (anchored to the next native pen).
      if (c.isHighlight) setHighColor(c); else setPenColor(c);
      setStatus(`${c.label} set for the current pen. Switch pens to return to native.`);
    }
  };

  // Apply button (lasso mode): recolor the selection, remove the lasso, close.
  const applyAndClose = async () => {
    if (busy) return;
    if (!selected) { setStatus('Tap a colour first, then “Apply & Close”.'); return; }
    const ok = await applyLassoRecolor(selected);
    if (!ok) return;                                          // keep panel open to show the error
    await PluginCommAPI.setLassoBoxState(2).catch(() => {});  // 2 = remove lasso permanently
    PluginManager.closePluginView();
  };

  // ── Apply colour to lasso selection via sidecar ───────────────────────────
  // Records the chosen colour in the per-note sidecar file keyed by page +
  // numInPage.  No modifyElements / saveCurrentNote calls — the note file is
  // never touched, so the native lasso menu and writing remain fully
  // unaffected.  ExportColorPDF reads the sidecar at export time to apply
  // per-element colours.  Returns true on success.
  const applyLassoRecolor = async (color: ColorEntry): Promise<boolean> => {
    setBusy(true); setStatus('Reading selection…');
    try {
      const fileResp = await PluginCommAPI.getCurrentFilePath();
      if (!fileResp.success) { setStatus('Could not read note path.'); return false; }
      const notePath = fileResp.result as string;

      // Recolor from the snapshot captured at button-press; the live
      // getLassoElements collapses once this full-screen panel is open.
      const snap = getLassoSnapshot();
      if (!snap || snap.strokes.length === 0) {
        setStatus('No lasso captured. Lasso content, then tap Recolor.');
        return false;
      }

      const tuples = snap.strokes.map(s => ({
        uuid: s.uuid || '', hex: color.hex, page: snap.page, numInPage: s.numInPage, geom: s.geom || '',
      }));

      await updateColorMapAndSave(tuples, notePath);
      setStatus(`Applied ${color.label} to ${tuples.length} element(s).`);
      return true;
    } catch (err: any) {
      setStatus(`Error: ${err?.message ?? String(err)}`);
      return false;
    } finally { setBusy(false); }
  };

  // Header button. In lasso mode it APPLIES the recolor to the selection, then
  // removes the lasso and returns to the page (this IS the apply step — the
  // user's expected flow: pick a colour, tap the button to apply & return). In
  // picker mode it just closes.
  const onHeaderPress = () => {
    if (mode === 'lasso') { applyAndClose(); return; }
    // Picker mode: if a colour is shown checked, (re-)arm it for THIS note on
    // close — so hitting the button applies the checked colour without having to
    // re-tap it. The checkmark can be stale (armed for another note, or dropped
    // after a pen switch), so closing must re-commit it to the current note.
    if (selected) { if (selected.isHighlight) setHighColor(selected); else setPenColor(selected); }
    PluginManager.closePluginView();
  };

  const renderRow = (c: ColorEntry) => {
    const sel = selected?.penColor === c.penColor && selected?.label === c.label;
    return (
      <TouchableOpacity key={c.label}
        style={[styles.row, sel && styles.rowSelected]}
        onPress={() => selectColor(c)} activeOpacity={0.7}>
        <View style={[styles.swatch, { backgroundColor: c.hex }]} />
        <View style={styles.info}>
          <Text style={styles.label} numberOfLines={1}>{c.label}</Text>
          <Text style={styles.hex}>{c.hex}</Text>
        </View>
        {sel && <Text style={styles.check}>✓</Text>}
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Custom Color Palette</Text>
        <TouchableOpacity style={[styles.closeBtn, busy && styles.closeBtnDisabled]} onPress={onHeaderPress} disabled={busy}>
          <Text style={styles.closeBtnText}>
            {mode === 'lasso' ? (busy ? 'Applying…' : 'Apply & Close') : 'Close'}
          </Text>
        </TouchableOpacity>
      </View>

      <View style={styles.banner}>
        <Text style={styles.bannerText}>
          {mode === 'lasso'
            ? 'Tap a colour, then tap “Apply & Close” to recolor the lasso selection.'
            : 'By default strokes keep their own pen colour. Tap a colour to apply it to the pen you’re using now; switch pens to return to native. Use Export Color PDF to see colours.'}
        </Text>
      </View>

      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        <View style={[styles.column, styles.columnLeft]}>
          {LEFT_COLUMN.map(renderRow)}
        </View>
        <View style={styles.column}>
          {RIGHT_COLUMN.map(renderRow)}
        </View>
      </ScrollView>

      {status !== '' && (
        <View style={styles.statusBar}>
          <Text style={styles.statusText}>{status}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root:            { flex: 1, backgroundColor: '#FFFFFF' },
  header:          { flexDirection:'row', alignItems:'center', justifyContent:'space-between', paddingHorizontal:20, paddingVertical:14, borderBottomWidth:1, borderBottomColor:'#000000' },
  headerTitle:     { fontSize:18, fontWeight:'bold', color:'#000000' },
  closeBtn:        { borderWidth:1, borderColor:'#000000', paddingHorizontal:16, paddingVertical:8 },
  closeBtnDisabled:{ borderColor:'#888888' },
  closeBtnText:    { fontSize:14, color:'#000000' },
  banner:          { backgroundColor:'#F4F4F4', paddingHorizontal:20, paddingVertical:10, borderBottomWidth:1, borderBottomColor:'#DDDDDD' },
  bannerText:      { fontSize:12, color:'#333333', lineHeight:18 },
  list:            { flex:1 },
  listContent:     { flexDirection:'row', paddingVertical:8 },
  column:          { flex:1 },
  columnLeft:      { borderRightWidth:1, borderRightColor:'#EEEEEE' },
  row:             { flexDirection:'row', alignItems:'center', paddingHorizontal:16, paddingVertical:14, borderBottomWidth:1, borderBottomColor:'#EEEEEE' },
  rowSelected:     { backgroundColor:'#F0F0F0' },
  swatch:          { width:40, height:40, borderWidth:1, borderColor:'#999999', marginRight:14 },
  info:            { flex:1 },
  label:           { fontSize:18, fontWeight:'600', color:'#000000' },
  hex:             { fontSize:12, color:'#555555', marginTop:2 },
  check:           { fontSize:26, fontWeight:'bold', color:'#000000' },
  statusBar:       { paddingHorizontal:20, paddingVertical:10, borderTopWidth:1, borderTopColor:'#CCCCCC', backgroundColor:'#F8F8F8' },
  statusText:      { fontSize:12, color:'#333333' },
  applyBtn:        { backgroundColor:'#000000', paddingVertical:18, alignItems:'center', justifyContent:'center' },
  applyBtnDisabled:{ backgroundColor:'#888888' },
  applyBtnText:    { fontSize:17, fontWeight:'bold', color:'#FFFFFF' },
});
