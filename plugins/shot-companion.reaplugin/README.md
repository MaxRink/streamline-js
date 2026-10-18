# Shot companion

A Decaid plugin that adds to the Streamline dashboard through its
[plugin surfaces](../../docs/plugin-surfaces.md). It complements the info row
(Water, Steam, Tank, Clock, Weight) with what that row does not show. With the
plugin off, the dashboard is unchanged.

| Where | What | Surface |
|---|---|---|
| Top bar | The current coffee's name. Its tooltip gives the roaster and days off roast. Tap it for the bean card | `header-button`, `open` overlay |
| Bean card | Roaster, roast date, roast level, beans left in the batch, how many shots used this coffee, and the last one (profile, grind, dose → yield, time) | the plugin's `ui` page |
| Info row, during an espresso | Weight against the Drink target (with a bar), pressure and flow against the profile (with a status dot), the current step, and today's shot number | `shot-strip`, `show: "shot"` |
| Under Grind, Dose and Drink | `Last 6.4`, `Last 18g`, `Last 36g` from the last matching shot. Tap to use that value again; the pill is highlighted when the tile already has it | `tile-hint` with `set` |
| Under the Drink label | What the last matching shot produced, for example `37.2g · 28s` | `tile-line` |

The skin draws the live numbers from its own snapshot stream. The plugin never
writes the workflow and never commands the machine: a tapped pill goes through
the skin's own tile setter, as a typed value would.

## Settings

| Setting | Default | |
|---|---|---|
| Current bean button | on | The top-bar button. Only one plugin header button is drawn, so another plugin earlier in Decaid's list may take the slot |
| Live shot strip | on | The info-row strip during an espresso |
| Last-shot pills | on | The Grind, Dose and Drink pills and the Drink line |
| Last shot of | Same profile | `Same profile`, `Same coffee` (falls back to the profile when the workflow has no coffee name) or `Any shot` |

## How it stays current

- It reads `GET /api/v1/workflow` on load, then follows `workflowUpdated`
  (`events.workflow`). A new profile, coffee or bean batch triggers a new lookup.
- `shotStored` and `shotUpdated` (`events.shots`) re-read the last shot,
  today's count and the batch (beans left changes after a shot).
- After a change it emits `{"what":"skin"}` on its `changed` websocket, which
  the skin declares as `live`, so the dashboard follows at once. It emits only
  when its answer actually changed.
- `skin` is answered from memory, so it never waits on Decaid or the machine.
- Today's number counts the newest 100 shots and shows `#101+` past that.

## Install on a running Decaid

```bash
DECAID=http://<tablet>:8080
node -e '
const fs = require("fs");
const dir = "plugins/shot-companion.reaplugin";
process.stdout.write(JSON.stringify({
  manifest: JSON.parse(fs.readFileSync(dir + "/manifest.json", "utf8")),
  plugin: fs.readFileSync(dir + "/plugin.js", "utf8"),
}));' > /tmp/shot-companion.json
curl -X PUT "$DECAID/api/v1/plugins/shot-companion.reaplugin/source" \
  -H 'content-type: application/json' --data @/tmp/shot-companion.json
curl -X POST "$DECAID/api/v1/plugins/shot-companion.reaplugin/enable"
curl "$DECAID/api/v1/plugins/shot-companion.reaplugin/skin"
```

The last call shows exactly what the skin will read.

## Tests

`test/shot-companion-plugin.test.mjs` runs `plugin.js` with a fake host and a
fake Decaid, and checks every answer through the skin's own `parseSkinAnswer`,
so a change that the skin would drop fails the test.
