# plugin-ui: a shared look for Decaid plugin pages

`plugin-ui.css` and `plugin-ui.js` give pages that a Decaid plugin serves (setup wizards, settings, diagnostics)
the Streamline look. Pages built with them follow the host's theme and language, use tablet-sized touch
targets, and close correctly whether they run in a Streamline overlay, in Decaid's native surface sheet, or in a
plain browser tab. There are no dependencies and no build step. A plugin copies the two files into its
`plugin.js` with `vendor.mjs` and serves them inline.

Open [`demo.html`](demo.html) for every component and a four-step wizard. `?theme=dark`, `?lang=de` and
`?embed=1` show the variants.

## Page parameters

A page reads these from its own URL. Unknown or missing values fall back to the defaults.

| Parameter | Sent by | Effect |
|---|---|---|
| `theme=light\|dark` | Streamline (`data-theme`); Decaid's native sheet (its ThemeMode) | Sets `data-theme` on `<html>`. Without it, `prefers-color-scheme` decides. |
| `lang=<bcp47>` | the host's current language | Picks the `pu.t()` table. Only the primary subtag is used. Defaults to English. |
| `embed=1` | Streamline overlays and surface dialogs; the native sheet | Hides `[data-pu-done]` because the host draws its own close button, and makes `body` transparent. `pu.init()` posts `streamline:ready`. |
| `returnTo`, `return` | Streamline Extensions "Open"; a skin's own link | Where `pu.done()` goes in a plain tab. Validated as described under `pu.done()`. |
| `ui=1`, `deviceId`, `deviceName` | Decaid device surfaces | Unchanged; for the page itself. |

## Markup

Put `class="pu"` on `<body>` and wrap the content in `.pu-page`.

| Class / attribute | Use |
|---|---|
| `.pu-header` + `[data-pu-done]` | Title row with a Done button (hidden when embedded) |
| `.pu-card`, `.pu-row` | Grouped settings. A row is label, control and optional `.pu-hint`; one column below 600px, two columns above. |
| `.pu-btn`, `.pu-secondary`, `.pu-danger` | Buttons, at least 56px high (`--pu-tap`) |
| `.pu-actions`, `.pu-sticky` | Button bar, optionally pinned to the bottom |
| `input.pu-switch[type=checkbox][role=switch]` | On/off switch |
| `fieldset.pu-choice` with radio `label`s | Plain-language choice cards for enums, using `<b>` for the title |
| `.pu-pill.pu-ok\|pu-warn\|pu-error` | Status chips |
| `.pu-alert.pu-ok\|pu-warn\|pu-error` | Inline messages |
| `.pu-code` | Fingerprints and other machine text; wraps anywhere |
| `details.pu-details` | Collapsed Advanced sections |
| `.pu-secure` + `[data-pu-reveal]` | Secret input with a Show/Hide button |
| `[data-pu-step]`, `[data-pu-stepper]`, `[data-pu-back]`, `[data-pu-next]` | Wizard steps, progress dots ("Step 2 of 5") and navigation |
| `[data-pu-t="key"]` | Text replaced with `pu.t(key)` on `pu.init()` |

Rows and form fields are at least 48px high (`--pu-row`). `check.mjs` enforces both sizes on the demo at
phone and tablet widths in both themes.

## Tokens

`--pu-bg`, `--pu-surface`, `--pu-text`, `--pu-muted`, `--pu-border`, `--pu-accent`, `--pu-link`,
`--pu-on-accent`, `--pu-ok`, `--pu-warn`, `--pu-danger`, `--pu-radius`, `--pu-tap`, `--pu-row`, `--pu-scheme`.
Light and dark values follow Streamline's palette (`src/css/main.css`, `src/css/dark-mode.css`).

`<html>` never gets `color-scheme: dark`, because a framed page would then paint an opaque canvas (see
[plugin-surfaces.md](../plugin-surfaces.md), Actions > `open`). Form controls get `color-scheme` one by one
instead.

## Script: `window.pu`

- `pu.init({strings, fit})` adds translation tables (`{de: {"Key": "Schlüssel"}}`) and applies `[data-pu-t]`.
  When embedded it posts `streamline:ready`. With `fit: true` it also posts `streamline:size` for `.pu-page`
  now and whenever its size changes; pair it with `"fit": true` on the skin's `open` action.
- `pu.t(key, vars)` translates and fills `{name}` placeholders. Missing keys fall back to the key itself, so the
  English text is the key.
- `pu.done()` closes the page in whatever opened it:
  - inside a frame: posts `streamline:close`;
  - in Decaid's native sheet: calls `flutter_inappwebview.callHandler('pluginSurface', {type: 'close'})`;
  - otherwise: goes to `returnTo` or `return`, then falls back to `history.back()`.
  - Only same-host HTTP(S) targets without credentials are followed. A skin-local `return` path is resolved
    against the live skin port and must stay on that origin, as
    [Decaid's plugin guide](https://github.com/decentespresso/decaid/blob/main/doc/Plugins.md#the-return-parameter)
    requires.
- `pu.api(path, {method, body})` is a same-origin JSON fetch. On a non-2xx answer it throws an `Error` whose
  `status` and `data` hold the response.
- `pu.secureValue(input, wasSet)` returns the value to send for a secure setting: the typed text, or
  `{"isSet": true}` to keep a stored secret, or `undefined` (leave the key out) when nothing is stored and
  nothing was typed. Decaid never returns secure values, so a page only knows `wasSet` from
  `GET /api/v1/plugins/<id>/settings`. Clear the input after saving.
- `pu.fingerprint(hex)` formats a SHA-256 digest as `91:B4:...` for display.
- `pu.wizard(container, onNext)` runs the `[data-pu-step]` sections. `onNext(index, section)` may return
  `false` (or a promise of `false`) to stay on the current step. Moving to a step focuses its `<h2>`.

## Using it from a plugin

Serve the page from your `__httpRequestHandler` with both files inline. Add an empty marker block to
`plugin.js` once:

```js
/* plugin-ui:begin */
/* plugin-ui:end */
```

then vendor the kit into it:

```sh
node /path/to/streamline-js/docs/plugin-ui/vendor.mjs inject plugin.js
# or straight from GitHub, pinned to a commit:
node vendor.mjs inject plugin.js https://raw.githubusercontent.com/MaxRink/streamline-js/<commit>/docs/plugin-ui
```

The block becomes `const PLUGIN_UI = {version, sha256: {css, js}, css, js};`. Build pages with it:

```js
function page(title, body, script) {
  return `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>${PLUGIN_UI.css}</style><body class="pu"><main class="pu-page">${body}</main>
<script>${PLUGIN_UI.js}</script><script>${script}</script></body></html>`;
}
```

Escape everything you interpolate that is not your own constant text. `vendor.mjs` refuses kit text that
contains `</style` or `</script`.

Guard the copy in your CI:

```sh
node vendor.mjs check plugin.js                  # the block was not edited by hand
node vendor.mjs check plugin.js <kitDir|kitUrl>  # the block matches that kit version
node vendor.mjs hash                             # print this kit's sha256 values
```

Change the kit here, never in a vendored copy, then re-run `inject` in each plugin.

## Checking changes to the kit

```sh
node docs/plugin-ui/check.mjs
```

It tests inject and check (a hand edit, a stale copy, missing markers). When Playwright is available it renders
`demo.html` at 412px and 1280px in both themes, and checks touch-target sizes, horizontal overflow, theme
background and the German strings. It uses Playwright's browser, or the installed Chrome when Playwright's
browser is not downloaded.
