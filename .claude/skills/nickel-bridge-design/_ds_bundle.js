/* Nickel Bridge DS runtime loader.
   Stands in for the auto-generated bundle: synchronously fetches the component
   sources, strips ESM syntax, transpiles JSX with Babel (must be loaded first),
   and exposes every export on window.NickelBridge. Load order matters. */
(function () {
  var script = document.currentScript;
  var root = script.src.replace(/_ds_bundle\.js.*$/, '');
  var files = [
    'components/brand/BridgeMark.jsx',
    'components/brand/TicketStub.jsx',
    'components/brand/FlipDigits.jsx',
    'components/brand/InkStamp.jsx',
    'components/brand/Postmark.jsx',
    'components/brand/PerforatedPanel.jsx',
    'components/core/Button.jsx',
    'components/core/Chip.jsx',
    'components/core/Input.jsx',
    'components/core/Select.jsx',
    'components/core/Checkbox.jsx',
    'components/core/Radio.jsx',
    'components/core/Switch.jsx',
    'components/core/Dialog.jsx',
    'components/core/Toast.jsx',
    'components/navigation/AppHeader.jsx',
    'components/navigation/TabBar.jsx',
    'components/game/PlayingCard.jsx',
    'components/game/StarGrade.jsx',
    'ui_kits/app/screens1.jsx',
    'ui_kits/app/screens2.jsx',
    'ui_kits/app/screens3.jsx'
  ];
  window.NickelBridge = window.NickelBridge || {};
  files.forEach(function (p) {
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', root + p, false);
      xhr.send();
      if (xhr.status >= 400) { console.warn('[NickelBridge DS] missing ' + p); return; }
      var src = xhr.responseText;
      var names = [];
      src = src.replace(/^import[^\n]*\n/gm, function (m) {
        var mm = m.match(/import\s*\{([^}]+)\}/);
        return mm ? 'const {' + mm[1] + '} = window.NickelBridge;\n' : '';
      });
      src = src.replace(/^export function (\w+)/gm, function (m, n) { names.push(n); return 'function ' + n; });
      src = src.replace(/^export const (\w+)/gm, function (m, n) { names.push(n); return 'const ' + n; });
      var code = Babel.transform(src, { presets: [['react', { runtime: 'classic' }]], filename: p }).code;
      new Function(code + '\n' + names.map(function (n) { return 'window.NickelBridge.' + n + '=' + n + ';'; }).join(''))();
    } catch (e) {
      console.error('[NickelBridge DS] failed to load ' + p, e);
    }
  });
})();
