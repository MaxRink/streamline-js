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
  The message body may be JSON `{"what":"skin"}` to say that only your `skin` answer changed; the skin then does not
  re-read the workflow. Any other body (`{"what":"workflow"}`, no body, text that is not JSON) re-reads both.
  A plugin that only wants to push (for example decent-sync) declares an http `skin` endpoint and a websocket
  endpoint, with `api` and `emit` in `permissions`, and answers `{"version":1,"surfaces":[],"live":{"endpoint":"changed"}}`;
  empty `surfaces` with `live` is valid. A push that re-reads the workflow (anything but `{"what":"skin"}`) also makes the DYE strip re-read its data.
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
| `screensaver-button` | over the screensaver | `label` (required, 24), `image` (https), `action` (`open` only, required) |
| `ratio-action` | the "(1:x)" label under Drink | `title` (80), `action` (`open` or `call` with a fixed `value`, required) |
| `tile-hint` | under a tile's value | `tile`, `text` (required, 24), `title` (80), `active` |
| `tile-line` | under a tile's label | `tile`, `text` (required, 40), `active` |
| `tile-mode` | an option in the toggle under a tile's label | see [Tile modes](#tile-modes) |

`tile` is one of `dose`, `drink`, `grind`, `temperature`; a `tile-mode` can also be on `steam`, `hotwater` or `flush`. Lengths are characters. Text is shown with
`textContent`, never as HTML.

## Limits

- At most 16 surfaces per plugin, 1 `header-button`, 1 `screensaver-button`, 1 `ratio-action`, 1 `tile-hint` and 1 `tile-line` per tile, and up to 3 `tile-mode` per tile (see Modes); extras are dropped in order.
- If two plugins ask for the same tile slot, the first one wins.
- Only one plugin `header-button` is drawn in total across all plugins; the first plugin in Decaid's plugin list whose `skin` read succeeds wins.
- Only one `screensaver-button` is drawn in total across all plugins, first plugin wins, as for `header-button`.
- Only one `ratio-action` is drawn in total across all plugins, first plugin wins.
- `id` is 1 to 40 characters of `A-Z a-z 0-9 _ -` and unique within the answer.
- `image` must be `https:` without credentials.
- Unknown `kind`s are ignored, so a newer plugin on an older skin shows less rather than failing.

## Screensaver button

A `screensaver-button` is drawn at the top centre of the screensaver, for a plugin page worth reaching while the machine sleeps. It takes an `open` action only (`page` or `overlay`); without one it is dropped.

- It never wakes the machine and sends no machine command. A tap on it is not a tap on the saver, so the saver stays up. The saver is left only by waking the machine, which the plugin button does not do; the user taps the saver elsewhere, as before.
- Pressing it brings the panel back to the user's brightness (display only) so the page can be read. With `overlay`, closing the dialog dims the panel again if the machine is still asleep. With `page`, the skin is left; on return the first snapshot raises the saver and dims again, and boot sends no wake.
- It sits at the top right of the saver and is shown on every saver, the image saver and the black screen.

## Ratio action

The skin's own "(1:2.7)" label under Drink does nothing when tapped. A `ratio-action` gives it a tap: the label keeps its text and gets a dotted underline and a larger tap area while a plugin has declared one. It takes `open` (`page` or `overlay`, so the plugin can draw a "set ratio" sheet) or `call` with a fixed `value` (a toggle or a cycle). Without a valid action it is dropped and the label stays as before.

After a `call` the skin reads `skin` and the workflow again, so a yield the plugin wrote shows at once. An overlay that wrote the workflow should `emit` on the plugin's `live` socket before it closes.

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
| `tile` | `dose`, `drink`, `grind`, `temperature`, `steam`, `hotwater` or `flush` |
| `label` | the option in the toggle, required, 6 characters |
| `unit` | appended to the value, 3 characters, optional |
| `value` | the plugin's current number, required, clamped to `min`..`max` and rounded to `decimals`; `presets` likewise |
| `min`, `max` | required, `min < max`, each within -9999..9999 and a multiple of 10^-`decimals` (`min` 0.4 with `decimals` 0 is dropped) |
| `step` | what the tile's `-` / `+` change by, rounded to `decimals`, at least 10^-`decimals` and at most `max - min`, default 1 (`step` 0.4 with `decimals` 0 is dropped; 0.5 rounds up to 1) |
| `decimals` | digits shown, 0 to 2, default 0 |
| `presets` | up to 4 numbers shown in the tile's preset row while the mode is selected; only Brew, Drink, Flush and Steam have a preset row, Grind and Dose ignore them |
| `menu` | optional, up to 4 `{ "label": "Reset to 0%", "value": 0 }` (label 24 characters, `value` clamped to `min`..`max`); extra items in each preset's long-press menu |
| `presetsEditable` | optional, `false` to stop the user changing the presets from that menu (default `true`) |
| `second` | optional, on `steam`, `hotwater`, `flush` and `drink` only: a second number on a second line under the value, for example a flow beside a time: `{ "field": "flow", "value": 1.0, "min": 0.4, "max": 2, "decimals": 1, "unit": "ml/s" }`. `field` is a name like `call`'s (and not the mode's own), `unit` up to 6 characters. Tapping it opens the numpad. Every call of the mode then carries **both** numbers, `{ "<field>": <value>, "<second.field>": <second> }`, so a newer call never drops the other one; apply both, and answer with the values you want shown |
| `applyOnSelect` | optional, `true` to make the skin send the mode's `value` to your `call` as soon as the user picks the mode, as if they had tapped a preset (for a mode that sets more than one thing at once); default `false` |
| `action` | required, a `call`; a mode without a valid one is dropped |

While the mode is selected the tile shows `value` and `unit`, `-` / `+` step by `step`, tapping the value opens the
numpad for free entry, and a preset applies directly. For negative entry the numpad's `.` key becomes `±`, which
is only done when `min` is below 0 and `decimals` is 0; with decimals the numpad stays positive-only. Each of
those sends the new number to the plugin with the `call`, and the skin then reads `skin` again: the `value` you
answer with is the truth, so a number you reject or adjust snaps back.

Rules:

- A plugin may add up to 3 `tile-mode` to a tile. A tile's row holds at most 3 options in total: the built-in one
  and two plugin options, except on `steam`, `hotwater` and `flush`, which have no built-in option in the row and hold three plugin options.
  On `steam` the `Time | Flow` toggle above it ends a plugin mode, on `hotwater` the `Temp | Vol` toggle does; on `flush` a tap on the `Flush` label does. If plugins ask for more, the first in
  Decaid's plugin list win. Keep each `label` short (6 characters).
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
  popups.

  **Your `ui` response must allow framing when the skin is on another origin.** Decaid adds
  `X-Frame-Options: SAMEORIGIN` to every plugin page, so a skin served from a different origin than Decaid (a dev
  server on `:8044` against Decaid on `:8080`) gets "refused to connect" in the dialog. Send
  `Content-Security-Policy: frame-ancestors 'self' <skin origin>` on the `ui` response: a browser ignores
  `X-Frame-Options` when `frame-ancestors` is present. The skin's origin is the `Origin` of its requests, or the
  `Referer` of the frame request; the embed URL carries no `returnTo`. When the skin and Decaid share an origin
  (the production setup) `SAMEORIGIN` already allows it. Without a ready message the skin gives up after 3 seconds
  and opens the page instead.

  Messages are accepted only from the overlay's own frame. Only one overlay is open at a time.
  - **The stock numpad.** Post `{ type: 'streamline:numpad', id: 'r1', title: 'Ratio', unit: 'x', min: 1, max: 5,
    decimals: 1, value: 2.5 }` and the skin opens its own full-screen numpad over the overlay (see `input` under
    `call` for the fields and limits). The answer comes back to that frame as
    `{ type: 'streamline:numpad-result', id: 'r1', value: 2.5 }`, or `value: null` when the user cancels, another
    numpad is already open or the request is invalid. `id` (a string or number) is echoed so you can match answers.
- **`step`**: `{ "type": "step", "field": "targetDoseWeight", "by": -0.5 }` on tile kinds only. Moves the
  tile's current value by `by` (a non-zero number, at most 100 either way) and goes through the same setter as
  `set`, so the result is clamped to the same range and the profile remembers it. `field` is `targetDoseWeight`,
  `targetYield` or `grinderSetting`; brew temperature is not steppable. Nothing happens until the tile shows a
  number. It steps the value the tile shows (grind shows one decimal, so steps finer than 0.1 round with it),
  and a plugin `tile-mode` on the same tile owns that tile's value, so do not step it. Not allowed on a `tile-mode`
  or a header button. Use it for a pill such as "+0.5 g" when your plugin does not need to know the current value.
  Once the value is stored the skin reads `skin` again, so the plugin's pills reflect the new number (no
  `workflow-refresh` is sent).
- **`stepsize`**: `{ "type": "stepsize", "field": "targetDoseWeight", "sizes": [1, 0.5, 0.1] }` on `tile-hint` and
  `tile-line` only. `field` is `targetDoseWeight`, `targetYield` or `grinderSetting` (brew
  temperature is not steppable). On grind a whole-number size shows whole numbers and any other size shows one
  decimal; without a grind `stepsize` the tile keeps its own rule (1 for a whole number, 0.1 otherwise). `sizes` has 1 to 4 numbers, each greater than 0 and at most 10, rounded to
  hundredths; anything else drops the action. The pill changes what the tile's own `-` / `+` move by: each tap
  moves to the next size and wraps. The skin draws the pill text itself (`±0.5 g`, no `g` on grind, from the size stored on this
  device; your `text` is ignored), and the choice is kept per field in this device's local storage, not synced.
  The size applies only while a `stepsize` surface for that field is drawn; when the plugin goes away the
  tile's step is 1 again. The numpad and presets are unaffected. A plugin `tile-mode` on the tile intercepts
  `-` / `+` itself, so the step size has no effect while a mode is selected.
- **`set`**: `{ "type": "set", "field": "targetYield", "value": 36 }` on tile kinds only. `field` is one of
  `targetDoseWeight` (1 to 30), `targetYield` (1 to 2000), `grinderSetting` (0 to 9999) or `brewTemperature`
  (70 to 105, **degrees Celsius**). The maximums are the ones the tile enforces when the user types a value;
  the tile's minimum is 0, and dose, yield and brew temperature use a higher one here (grind is the same 0). `value` is a number or a numeric string; it is clamped to that
  range and rounded to hundredths. It goes through the same setters as a tile edit, so **the active profile
  remembers it** until it is changed again.

  > **`brewTemperature` moves the whole curve.** `value` is where the profile's *first* step goes, and every other
  > step moves by the same amount, exactly like the Brew tile's `-`/`+`: a profile with steps 94, 90, 88 set to 92
  > becomes 92, 88, 86. A profile with one temperature stays flat. The profile then remembers it, and the distances
  > always come from the saved profile, so a profile that was flattened earlier gets its shape back.
  >
  > Like the tile, it writes nothing when the current workflow has no profile steps, and the tile still shows the
  > requested value until the next refresh.

- **`call`**: `{ "type": "call", "endpoint": "apply", "field": "percent" }` on a `tile-mode`, or
  `{ "type": "call", "endpoint": "ratio", "field": "lock", "value": 1 }` on a `tile-hint` or `tile-line`, where
  `value` is a fixed number (required, at most 99999 in size, rounded to hundredths) sent when the pill or line is tapped. A header button
  cannot call. Instead of `value`, a hint, a line or a `ratio-action` may carry `input`, which makes the tap open the
  skin's own full-screen numpad and send the number the user types:
  `{ "type": "call", "endpoint": "ratio", "field": "ratio", "input": { "title": "Ratio", "unit": "x", "min": 1, "max": 5, "decimals": 1, "value": 2.5 } }`.
  `min` and `max` are required (`min` below `max`, each at most 99999 in size); `decimals` is 0 to 2 (default 0);
  `value` is the number the numpad starts on (default `min`; clamped); `title` (24) and `unit` (6) are optional text.
  The typed number is clamped and rounded to those limits, a cancel sends nothing, and the numpad remembers the
  numbers entered for this surface as its previous-value pills. A bad `input` drops the action. A `tile-mode` has its
  own numpad already and takes no `input`. The skin sends `POST /api/v1/plugins/{id}/{endpoint}` with the JSON body `{ "<field>": <number> }`. `endpoint`
  must be an http endpoint your manifest declares and is never one of `skin`, `settings`, `enable`, `disable`,
  `source`, `update` or `install` (Decaid serves those routes itself, so they never reach your endpoint).
  `field` is a name of letters, digits and `_` starting with a letter, up to 40 characters. The reply body is
  ignored. A non-2xx status is logged, and a call that does not answer within about 5 s is given up; either way the
  tile goes back to what `skin` says. `-` / `+` presses are sent after the user pauses for about 300 ms (only the
  last number is sent); presets and numpad entry are sent immediately. Only one call per tile is in flight, and
  the newest wins. After a call succeeds the skin also re-reads the workflow and repaints the tiles from it, so the
  plugin must answer the call only after its own `PUT /workflow` has completed.

## How the tiles follow the workflow

Decaid has no workflow websocket and `GET /workflow` carries no revision, so the skin re-reads it at these moments:

- after every write the skin makes itself (`set`, `step`, a tile edit), at once and again about 1.5 s later for a
  plugin that reacts to the write;
- after a successful plugin `call`, and on a `live` push that is not `{"what":"skin"}`;
- when the machine state changes (a shot ends, the machine wakes), when the window regains focus or becomes visible,
  and on a 20 s timer.

Each read paints dose, yield, grind, brew temperature, steam, hot water and flush from the workflow, whether or not
the value differs from the last read, so a value a plugin set back to what the skin last saw still reaches the tile.
Only an edit that has not reached Decaid yet (a tile press inside its 1 s debounce, or a write still in flight) is
held back. A change of profile reloads the dashboard data instead. A plugin that writes the workflow and wants the
dashboard to follow at once should `emit` on its `live` socket.

Nothing else can be written: no machine commands, and no profile changes other than the remembered dose, yield,
grind and the profile temperature that `set` itself writes (see the `brewTemperature` note above).

## Notes on ratio keeping

- Keeping a ratio while the dose changes is only possible as a dose `tile-mode` (the plugin owns the value and
  can write yield), or as a pill with `call` + `active` + `live` that tells the plugin to hold the ratio and
  shows its state. Put the pill under the Drink label as a `tile-line`, or under the value as a `tile-hint`; a
  `tile-mode` on Drink takes the label slot, so use the hint then. Store the switch where other apps can see it,
  for example `context.extras.lockRatio`.
- The plugin sees a changed dose through its `events.workflow` listener, writes `yield = dose x ratio` with
  `PUT /workflow` and `emit`s. A yield that changes with the same dose is the user choosing a new ratio, so adopt it.
- Tapping the ratio to enter a new one is a `ratio-action`: `call` to cycle through ratios, or `open` with
  `presentation: "overlay"` to draw a numpad (a pill cannot take numeric input).
- A scale weight under Dose is a `tile-line` on `dose` whose `call` or `set` uses the number. A plugin reads
  `/ws/v1/scale/snapshot` itself (`network.websocket` permission; checked against a real Decaid) and pushes
  `{"what":"skin"}` when the weight moves. Hiding it during a shot needs the machine state from Decaid's
  `events.machine` permission, which the plugin handles itself; that part is not tested here.
