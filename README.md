[README.md](https://github.com/user-attachments/files/28658569/README.md)
# Custom Color Palette — Supernote Plugin

A plugin for the Supernote NOTE app that provides a custom color picker for Ink Pen, Needle Point Pen, Shapes, and Highlighter content. Colors are applied to lasso-selected elements and are stored in the `.note` file, appearing in full color when exported to PDF or viewed on a color screen.

## Color palettes

### Ink Pen · Needle Point Pen · Calligraphy Pen · Marker as Marker
| Name                   | Hex      | Note         |
|------------------------|----------|--------------|
| Light Gray             |          |same as device|
| Dark Gray              |          |same as device|
| Black                  | #231F20  | **default**  |
| Blue                   | #0033A0  |              |
| Green                  | #007B5F  |              |
| Lime                   | #00FF00  |              |
| Orange                 | #FF8200  |              |
| Pink                   | #CD6FBD  |              |
| Purple                 | #763AC7  |              |
| Red                    | #BF062F  |              |

### Marker as Highlighter
| Name                   | Hex      | Note         |
|------------------------|----------|--------------|
| White                             |same as device|
| Highlighter Pink       | #FF4E8B  |**default**   |
| Highlighter Yellow     | #F6F000  |              | 
| Highlighter Orange     | #FFA442  |              | 
| Highlighter Blue       | #008BD1  |              |
| Highlighter Green      | #00E240  |              |
| Highlighter Purple     | #9B3CA2  |              |


## Requirements

- Node.js 18 or later
- Android SDK with `adb` in your PATH
- PowerShell (Windows) or Bash (macOS / Linux)
- React Native 0.79.2 (pinned — other versions may be incompatible with PluginHost)

## Build

```bash
npm install
bash buildPlugin.sh
```

Output: `build/outputs/CustomColorPalette.snplg`

## Deploy

```bash
adb push build/outputs/CustomColorPalette.snplg /storage/emulated/0/MyStyle/
```

Then on the device: **Settings → Apps → Plugins → Install**.

## Debug

```bash
adb logcat -c
# trigger an action on device, then:
adb logcat -d -s ReactNativeJS:V
```

## How it works

The plugin registers two toolbar buttons in the NOTE app:

| Button    | Appears when…          |
|-----------|------------------------|
| Colors    | Always (main toolbar)  |
| Recolor   | Lasso selection active |

Tapping either button opens the color picker full-screen. The user selects a tab, picks a color, then taps **Apply … to Selection**. The plugin calls `getLassoElements()`, sets `element.color` to the chosen ARGB integer, writes back via `modifyElements()`, and reloads the page.

## SDK note

The public `sn-plugin-lib` API does not expose a way to pre-set the active pen color before drawing. This plugin recolors **already-drawn, lasso-selected** elements. Colors are stored in the `.note` file and render correctly on color displays.

## License

MIT
