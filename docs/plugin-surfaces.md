# Plugin surfaces

A Decaid plugin can add small, fixed kinds of UI to the dashboard by answering a `skin` HTTP endpoint.
Streamline renders them in its own style and runs only actions from a fixed list. No plugin JavaScript runs
in the skin. With no plugin, or the plugin off, the dashboard is unchanged.

Discovery: a loaded plugin with an http endpoint named `skin`. `GET /api/v1/plugins/{id}/skin` returns:

```json
{
  "version": 1,
  "surfaces": [
    { "id": "main", "kind": "header-button", "label": "Plugin", "text": "Something chosen",
      "image": "https://example.com/photo.jpg", "action": { "type": "open", "view": "main" } },
    { "id": "grind", "kind": "tile-hint", "tile": "grind", "text": "Last 6.4", "title": "Last shot of this coffee",
      "action": { "type": "set", "field": "grinderSetting", "value": 6.4 } },
    { "id": "gear", "kind": "tile-line", "tile": "grind", "text": "EG-1 · 1200 rpm" }
  ]
}
```

Parsing and limits live in `src/modules/plugin-surfaces.js` (`parseSkinAnswer`). The answer is untrusted; anything
that does not validate is dropped, and the rest still shows.

## When it is read

- On dashboard load, every minute, and when the window regains focus or the dashboard becomes visible (at most once per 2 s).
- A read that fails or takes longer than 2 s hides that plugin's surfaces; it never blocks the dashboard.
- `header-button` is drawn before the system buttons. `tile-hint` and `tile-line` are drawn without moving the tile: a line under the label, a hint under the value.
- A tile surface with an action is tappable; its touch area is larger than the pill or line it shows.
- `active: true` on a hint or line draws it switched on (the skin's blue and bold, a ring on a hint), for a lock or
  a chosen option. It is only a look; whatever the surface does when tapped is its action.
- **Live updates.** Add `"live": { "endpoint": "changed" }` at the top level of the answer, where `changed` is a
  `websocket` endpoint of your manifest. While the page is visible (on any skin page, not only the dashboard) the skin
  keeps that socket open, and any message on it (whatever its body) makes the skin read `skin` again after about
  300 ms and re-read the workflow for the tiles. A stream of messages still refreshes about every 300 ms. If the
  user has just edited a tile, the tile re-read waits until the edit has settled (a few seconds) instead of
  being dropped. Use it for a value that moves (a scale weight) or when your plugin has just written the workflow.
  Messages should be sent when something changed, not on a timer faster than a second. Without `live`, or if the
  socket cannot open, the minute poll above still applies.
- Tile surfaces are placed from the label's measured size, so they are only drawn while the dashboard is visible;
  a read that finishes while it is hidden is drawn on the next refresh.

## Writing a plugin

A plugin needs two things beyond a normal Decaid plugin:

- The manifest lists an http endpoint `skin` (and `ui` if any surface uses `open`), and its `permissions` include
  `api`. Without `api`, Decaid refuses the endpoint calls.
- `__httpRequestHandler(request)` answers `skin` with the JSON above (`Content-Type: application/json`).

```json
{ "id": "my.reaplugin", "author": "You", "name": "My plugin", "description": "What it does.",
  "version": "1.0.0", "apiVersion": 1, "permissions": ["log", "api"], "settings": {},
  "api": [ { "id": "skin", "type": "http", "data": {} }, { "id": "ui", "type": "http", "data": {} } ] }
```

```js
__httpRequestHandler(request) {
  if (request.endpoint === 'skin') {
    return { requestId: request.requestId, status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 1, surfaces: [
        { id: 'main', kind: 'header-button', label: 'Mine', action: { type: 'open', view: 'main' } },
        { id: 'g', kind: 'tile-hint', tile: 'grind', text: 'Try 7.5',
          action: { type: 'set', field: 'grinderSetting', value: 7.5 } } ] }) };
  }
  // ...answer `ui` with your page
}
```

**Going back from your page.** An `open` navigates the same frame to your `ui` endpoint and adds
`?returnTo=<dashboard URL>&view=<view>`. Link back to `returnTo` (only if it is `http:` or `https:`); a link to
`/` goes to Decaid's root, not the skin. Escape both values if you put them in an inline script.

**Trying it.** Install a local copy on a running Decaid with
`PUT /api/v1/plugins/<id>/source` (body `{ "manifest": {...}, "plugin": "<plugin.js text>" }`), then
`POST /api/v1/plugins/<id>/enable`. Keep `version` the same or higher, Decaid rejects a downgrade.
`GET /api/v1/plugins/<id>/skin` shows exactly what the skin will read.

## Worked example: a brew temperature offset

A plugin that adds `°C | %` under **Brew**: any whole percent from -20 to 20, applied to every profile step so the
temperature curve keeps its shape. The plugin owns the maths and the write; the skin only shows the mode and
calls `apply`.

```json
{ "id": "temp-offset.reaplugin", "author": "You", "name": "Brew temp offset",
  "description": "Offsets every profile step's temperature by a percent.",
  "version": "1.0.0", "apiVersion": 1, "permissions": ["log", "api"], "settings": {},
  "api": [ { "id": "skin", "type": "http", "data": {} }, { "id": "apply", "type": "http", "data": {} } ] }
```

```js
function createPlugin(host) {
  const BASE = 'http://localhost:8080/api/v1';
  let baseline = null, percent = 0;      // the profile's own temperatures, and our offset

  const json = (req, status, body) => ({ requestId: req.requestId, status,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  return {
    id: 'temp-offset.reaplugin', version: '1.0.0',
    onLoad() {}, onUnload() {}, onEvent() {},
    async __httpRequestHandler(request) {
      if (request.endpoint === 'skin') {
        return json(request, 200, { version: 1, surfaces: [{
          id: 'pct', kind: 'tile-mode', tile: 'temperature', label: '%', unit: '%',
          value: percent, min: -20, max: 20, step: 1, decimals: 0, presets: [-5, -2, 2, 5],
          action: { type: 'call', endpoint: 'apply', field: 'percent' } }] });
      }
      if (request.endpoint === 'apply') {
        const p = Number(request.body && request.body.percent);   // body is parsed JSON
        if (!Number.isFinite(p) || Math.abs(p) > 20) return json(request, 400, { error: 'out of range' });
        const workflow = await (await fetch(BASE + '/workflow')).json();
        baseline = baseline || workflow.profile.steps.map(s => s.temperature);
        workflow.profile.steps.forEach((s, i) => {
          s.temperature = Math.round(baseline[i] * (1 + p / 100) * 10) / 10;
        });
        await fetch(BASE + '/workflow', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ profile: workflow.profile }) });
        percent = p;
        return json(request, 200, { percent });
      }
      return json(request, 404, { error: 'not found' });
    },
  };
}
```

Things a real plugin also has to decide, which the skin cannot do for it:

- **When the baseline is stale.** If the user switches profile or edits a step, `baseline` no longer describes the
  workflow. Compare what you last wrote with the workflow before reusing it, and start over when they differ.
- **What to send to `PUT /workflow`.** Decaid's deserializer is strict: drop legacy profile fields and send only the
  `profile`, as the skin's own `updateWorkflow` does (see `src/modules/api.js`).
- **Restarts.** A plugin that restarts forgets `baseline`. Persist it (`pluginStorage` permission) if the offset must
  survive.

## Checklist

- Manifest has `permissions: ["api"]` and an http endpoint for every id you use in `skin` (`skin`, `ui`, and any
  `call` endpoint). A `call` endpoint is not named `settings`, `enable`, `disable`, `source`, `update` or
  `install`.
- `skin` answers quickly (the skin gives it 2 s) and never needs the machine to be connected.
- A `call` endpoint answers within about 5 s; the skin gives up after that and shows what `skin` says.
- Every `call` endpoint validates its number; the skin sends what the user typed within `min`..`max`, but anyone can
  POST to your endpoint.
- Answer `skin` with the value you actually applied; that is what the tile shows next.
- Keep text short: a mode `label` is 6 characters, a preset shows as `value` + `unit` in a 4-slot row.

## Kinds

| `kind` | Where | Fields |
|---|---|---|
| `header-button` | header controls | `label` (required, 24), `text` (40), `image` (https) |
| `tile-hint` | under a tile's value | `tile`, `text` (required, 24), `title` (80), `active` |
| `tile-line` | under a tile's label | `tile`, `text` (required, 40), `active` |
| `tile-mode` | an option in the toggle under a tile's label | see [Tile modes](#tile-modes) |

`tile` is one of `dose`, `drink`, `grind`, `temperature`; a `tile-mode` can also be on `steam` or `flush`. Lengths are characters. Text is shown with
`textContent`, never as HTML.

## Limits

- At most 3 surfaces per plugin, 1 `header-button`, and 1 `tile-hint` and 1 `tile-line` per tile; extras are dropped in order.
- If two plugins ask for the same tile slot, the first one wins.
- Only one plugin `header-button` is drawn in total across all plugins; the first plugin in Decaid's plugin list whose `skin` read succeeds wins.
- `id` is 1 to 40 characters of `A-Z a-z 0-9 _ -` and unique within the answer.
- `image` must be `https:` without credentials.
- Unknown `kind`s are ignored, so a newer plugin on an older skin shows less rather than failing.

## Tile modes

A `tile-mode` lets a plugin add its own option to a left-column tile, the way the steam control shows
`Auto | F | T` when the Auto Steam Calculator is on. The built-in option stays first.

```json
{ "id": "pct", "kind": "tile-mode", "tile": "temperature",
  "label": "%", "unit": "%", "value": 5,
  "min": -20, "max": 20, "step": 1, "decimals": 0,
  "presets": [-5, -2, 2, 5],
  "action": { "type": "call", "endpoint": "apply", "field": "percent" } }
```

| Field | Rule |
|---|---|
| `tile` | `dose`, `drink`, `grind`, `temperature`, `steam` or `flush` |
| `label` | the option in the toggle, required, 6 characters |
| `unit` | appended to the value, 3 characters, optional |
| `value` | the plugin's current number, required, clamped to `min`..`max` and rounded to `decimals`; `presets` likewise |
| `min`, `max` | required, `min < max`, each within -9999..9999 and a multiple of 10^-`decimals` (`min` 0.4 with `decimals` 0 is dropped) |
| `step` | what the tile's `-` / `+` change by, rounded to `decimals`, at least 10^-`decimals` and at most `max - min`, default 1 (`step` 0.4 with `decimals` 0 is dropped; 0.5 rounds up to 1) |
| `decimals` | digits shown, 0 to 2, default 0 |
| `presets` | up to 4 numbers shown in the tile's preset row while the mode is selected; only Brew, Drink, Flush and Steam have a preset row, Grind and Dose ignore them |
| `menu` | optional, up to 4 `{ "label": "Reset to 0%", "value": 0 }` (label 24 characters, `value` clamped to `min`..`max`); extra items in each preset's long-press menu |
| `presetsEditable` | optional, `false` to stop the user changing the presets from that menu (default `true`) |
| `action` | required, a `call`; a mode without a valid one is dropped |

While the mode is selected the tile shows `value` and `unit`, `-` / `+` step by `step`, tapping the value opens the
numpad for free entry, and a preset applies directly. For negative entry the numpad's `.` key becomes `±`, which
is only done when `min` is below 0 and `decimals` is 0; with decimals the numpad stays positive-only. Each of
those sends the new number to the plugin with the `call`, and the skin then reads `skin` again: the `value` you
answer with is the truth, so a number you reject or adjust snaps back.

Rules:

- One `tile-mode` per plugin per tile, and at most 3 options per tile in total (the built-in one included); if
  plugins ask for more, the first in Decaid's plugin list win.
- A mode on a tile replaces a `tile-line` on that tile, since both use the space under the label. On `steam`
  the toggle goes on the line under the built-in `Time | Flow` toggle; choosing a built-in steam mode ends a
  plugin mode, and a mode there takes the place of whichever of steam's preset rows is showing.
- Long-pressing a plugin preset opens the same menu as the built-in presets: *Apply*, *Enter value*, *Save current
  here* and *Revert to* (the plugin's own value). The user's edits are kept per plugin and mode on that device, and
  override the plugin's preset until reverted; the plugin only ever sees the number when it is applied. An edit
  belongs to the preset value it was made on: if you change or reorder your presets it is dropped, so it never
  lands on a different preset. With `presetsEditable: false` your own presets always show and old edits are ignored
  (kept, so they apply again if you unlock them). Your `menu`
  items follow, and choosing one is a `call` with that item's number. Set `presetsEditable: false` to leave only
  *Apply* and your items. A tile with no preset row (Grind, Dose) has no menu.
- While a mode is selected the tile's own value and preset row are hidden, not changed: they keep following the
  machine, and selecting the built-in option shows them again. A mode with no `presets` leaves that row empty.
- The selected mode is not remembered: after a reload the tile shows its built-in mode. What the plugin applied
  stays in effect, and the tile shows the real result.
- A `steam` mode is not drawn while the built-in steam mode is Auto (Auto Steam Calculator), because Auto owns
  the steam `-` / `+`; a selected steam mode is dropped when Auto is switched on, and the toggle comes back
  when Auto is left.
- Without the plugin, or with it off, the tile is exactly as it is today.
- The skin never writes anything for a mode; it only calls your endpoint. Changes to the profile or workflow are
  your plugin's to make, through Decaid's API.

## Actions

An invalid action drops the action only; the surface still shows, inert.

- **`open`**: `{ "type": "open", "view": "main", "presentation": "page" }`. Opens the plugin's `ui` page.
  `view` is the same id charset as above. `presentation` is `page` (default, same-frame navigation with
  `returnTo`) or `overlay`; anything else behaves as `page`.

  **`overlay`** shows your `ui` page in an iframe in a dialog over the dashboard, so the user never leaves it.
  The frame URL is your `ui` endpoint with `embed=1&theme=light|dark` (and `view` when given), without `returnTo`.
  Your page must:

  - post `window.parent.postMessage({ type: 'streamline:ready' }, '*')` once loaded. If the skin has not seen
    it within 3 seconds it closes the dialog and opens the page instead, the same as `page`;
  - post `{ type: 'streamline:close' }` when it is done. The skin also draws a close button (×), closes on a tap
    outside the dialog and on Escape, then re-reads `skin` and the workflow.

  The frame is sandboxed (`allow-scripts allow-same-origin allow-forms`): it cannot navigate the skin and has no
  popups. Decaid sends no `X-Frame-Options` or CSP on a plugin's `ui` response, so it can be framed as is. To
  allow only the skin, send `Content-Security-Policy: frame-ancestors <skin origin>` yourself; the skin's origin
  is the `Origin` of its requests (or the `Referer` of the frame request), the embed URL carries no `returnTo`.

  Messages are accepted only from the overlay's own frame. Only one overlay is open at a time.
- **`step`**: `{ "type": "step", "field": "targetDoseWeight", "by": -0.5 }` on tile kinds only. Moves the
  tile's current value by `by` (a non-zero number, at most 100 either way) and goes through the same setter as
  `set`, so the result is clamped to the same range and the profile remembers it. `field` is `targetDoseWeight`,
  `targetYield` or `grinderSetting`; brew temperature is not steppable. Nothing happens until the tile shows a
  number. Use it for a pill such as "+0.5 g" when your plugin does not need to know the current value.
- **`set`**: `{ "type": "set", "field": "targetYield", "value": 36 }` on tile kinds only. `field` is one of
  `targetDoseWeight` (1 to 30), `targetYield` (1 to 2000), `grinderSetting` (0 to 9999) or `brewTemperature`
  (70 to 105, **degrees Celsius**). The maximums are the ones the tile enforces when the user types a value;
  the tile's minimum is 0, and dose, yield and brew temperature use a higher one here (grind is the same 0). `value` is a number or a numeric string; it is clamped to that
  range and rounded to hundredths. It goes through the same setters as a tile edit, so **the active profile
  remembers it** until it is changed again.

  > **`brewTemperature` flattens the profile.** The tile's setter gives *every step* of the profile the same
  > temperature, so a profile with temperature steps (94, then 90, then 88) becomes one flat value, and the
  > profile then remembers it. If your plugin needs to keep the shape, for example an offset of the whole curve,
  > do not use `set`: make the change from your plugin's own page or endpoint and write the profile yourself.
  >
  > Like the tile, it writes nothing when the current workflow has no profile steps, and the tile still shows the
  > requested value until the next refresh.

- **`call`**: `{ "type": "call", "endpoint": "apply", "field": "percent" }` on a `tile-mode`, or
  `{ "type": "call", "endpoint": "ratio", "field": "lock", "value": 1 }` on a `tile-hint` or `tile-line`, where
  `value` is a fixed number (required, at most 99999 in size, rounded to hundredths) sent when the pill or line is tapped. A header button
  cannot call. The skin sends `POST /api/v1/plugins/{id}/{endpoint}` with the JSON body `{ "<field>": <number> }`. `endpoint`
  must be an http endpoint your manifest declares and is never one of `skin`, `settings`, `enable`, `disable`,
  `source`, `update` or `install` (Decaid serves those routes itself, so they never reach your endpoint).
  `field` is a name of letters, digits and `_` starting with a letter, up to 40 characters. The reply body is
  ignored. A non-2xx status is logged, and a call that does not answer within about 5 s is given up; either way the
  tile goes back to what `skin` says. `-` / `+` presses are sent after the user pauses for about 300 ms (only the
  last number is sent); presets and numpad entry are sent immediately. Only one call per tile is in flight, and
  the newest wins.

Nothing else can be written: no machine commands, and no profile changes other than the remembered dose, yield,
grind and the profile temperature that `set` itself writes (see the `brewTemperature` note above).
