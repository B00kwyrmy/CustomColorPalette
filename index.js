import { AppRegistry } from 'react-native';
import App from './src/App';
import { PluginManager } from 'sn-plugin-lib';

AppRegistry.registerComponent('CustomColorPalette', () => App);

PluginManager.init();

// Toolbar button — always visible in NOTE app toolbar
PluginManager.registerButton(1, [1], {
  name: 'Colors',
  showType: 1,
  icon: '',
});

// Lasso toolbar button — shown when user has an active lasso selection
PluginManager.registerButton(2, [1], {
  name: 'Recolor',
  showType: 1,
  icon: '',
});

// Pending button state — consumed by App.tsx on mount to avoid timing gap
let _pendingButtonId = null;
let _pendingPressEvent = null;

PluginManager.registerButtonListener({
  onButtonPress: (event) => {
    _pendingButtonId = event.id;
    _pendingPressEvent = event.pressEvent;
  },
});

export function checkPendingButton() {
  const id = _pendingButtonId;
  const pressEvent = _pendingPressEvent;
  _pendingButtonId = null;
  _pendingPressEvent = null;
  return { id, pressEvent };
}
