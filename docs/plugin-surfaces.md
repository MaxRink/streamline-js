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
      "action": { "type": "set", "field": "grinderSetting", "value": "6.4" } },
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
- Actions on tile surfaces are not wired yet; they are shown, inert.
- Tile surfaces are placed from the label's measured size, so they are only drawn while the dashboard is visible;
  a read that finishes while it is hidden is drawn on the next refresh.

## Kinds

| `kind` | Where | Fields |
|---|---|---|
| `header-button` | header controls | `label` (required, 24), `text` (40), `image` (https) |
| `tile-hint` | under a tile's value | `tile`, `text` (required, 24), `title` (80) |
| `tile-line` | under a tile's label | `tile`, `text` (required, 40) |

`tile` is one of `dose`, `drink`, `grind`, `temperature`. Lengths are characters. Text is shown with
`textContent`, never as HTML.

## Limits

- At most 3 surfaces per plugin, 1 `header-button`, and 1 `tile-hint` and 1 `tile-line` per tile; extras are dropped in order.
- If two plugins ask for the same tile slot, the first one wins.
- Only one plugin `header-button` is drawn in total across all plugins; the first plugin in Decaid's plugin list whose `skin` read succeeds wins.
- `id` is 1 to 40 characters of `A-Z a-z 0-9 _ -` and unique within the answer.
- `image` must be `https:` without credentials.
- Unknown `kind`s are ignored, so a newer plugin on an older skin shows less rather than failing.

## Actions

An invalid action drops the action only; the surface still shows, inert.

- **`open`**: `{ "type": "open", "view": "main", "presentation": "page" }`. Opens the plugin's `ui` page.
  `view` is the same id charset as above. `presentation` is a hint: `page` (default, same-frame navigation
  with `returnTo`) or `overlay`. Anything else, and `overlay` until it exists, behaves as `page`.
- **`set`**: `{ "type": "set", "field": "targetYield", "value": 36 }` on tile kinds only. `field` is one of
  `targetDoseWeight`, `targetYield`, `grinderSetting`, `brewTemperature`. `value` is a finite number or a string
  of up to 20 characters; anything else drops the action. This answer is only checked for shape.

Nothing else can be written: no machine commands, no profile changes.
