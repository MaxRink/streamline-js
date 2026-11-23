# Plugin settings UI

Streamline discovers installed plugins from Decaid's `GET /api/v1/plugins`
response. Each plugin gets an Extensions page with its name, description,
enable switch, version/update status and controls derived from its manifest
settings. An HTTP endpoint named `ui` adds an **Open** button.

## Hide fields managed by your plugin

Set `hidden` to the JSON boolean `true` on any setting that should be edited
through your plugin's own UI instead of Streamline's generated form:

```json
{
  "settings": {
    "flowReadings": {
      "type": "string",
      "label": "Measured flow calibrations",
      "default": "[]",
      "hidden": true
    }
  },
  "api": [{ "id": "ui", "type": "http", "data": {} }]
}
```

This fragment belongs in an otherwise complete plugin manifest. Mark all your
settings hidden if your own UI handles the entire configuration, or hide only
internal fields and leave ordinary settings visible. Hidden fields do not
contribute keywords to Streamline's settings search. The plugin's own name,
description and Extensions entry remain visible, as do **Open**, the enable
switch and version/update controls. Declaring a `ui` endpoint alone does not
hide anything.

Omitting `hidden`, or setting it to `false`, preserves the existing form.
Only the boolean `true` hides a setting; the string `"true"` does not.

Keep the hidden fields in the manifest with their existing types and defaults.
Decaid 0.8.8 passes each setting's metadata through to skins and uses the same
declarations to retain and validate stored values. Removing a declaration can
discard its saved value. This presentation hint neither deletes nor changes
settings, and does not conceal values from the REST API. Use Decaid's `secure`
setting mechanism for credentials.

This is a Streamline convention. It does not require a new Decaid build, but
Decaid's native settings screen and other skins need their own support to hide
the same fields. Older Streamline versions continue displaying them.

## Presentation hints

Streamline also reads these optional per-setting keys. Like `hidden`, they are
presentation only and pass through Decaid unchanged:

| Key | Effect |
| --- | --- |
| `valueLabels` | `{value: label}` for an `enum`; the raw value is the fallback |
| `valueDescriptions` | `{value: text}` shown under the control for the selected value |
| `advanced: true` | Groups the setting under a collapsed **Advanced** section |
| `multiline: true` | Edits a `string` in a text area |

A `string` whose `default` is a JSON object or array is also edited in a text
area, and Streamline saves it only when it parses as an object or array. A
`secure` setting is write-only: the row shows **Set** or **Not set**, the field
stays empty, and a value is sent only when one is typed.

## Set up, Settings and Diagnostics pages

A plugin page in Streamline shows a button for each of the plugin's own pages
and opens it in a dialog over Settings:

- the top-level `surfaces` Decaid lists for the plugin (`role` `setup`,
  `settings` or `diagnostics`; at most one per role; an `endpoint` that names a
  declared HTTP endpoint, or an `href` on this plugin's pages on the Decaid API
  origin). A surface on endpoint `ui` is left to the **Open** button;
- on a host that does not list top-level surfaces, **Set up** for an HTTP
  endpoint named `setup`;
- device pages from a connected device's `surfaces` (`GET /api/v1/grinder/info`,
  `GET /api/v1/scale/info`). A plugin-level page whose endpoint a device also
  serves opens the device's page, which carries the `deviceId`.

The page URL gets `ui=1`, `surface=<id>`, `embed=1`, `theme=light|dark` and
`lang=<code>`. A page that posts `streamline:ready` to its parent (the
[plugin-ui kit](plugin-ui/README.md) does) is shown on the skin's theme
background, so keep its `body` transparent when embedded. Any other page gets a
white canvas. A page can close the dialog by posting `streamline:close`.

**Needs setup.** For a setup page, Streamline reads
`GET /api/v1/plugins/<id>/<setup endpoint>?status=1`. A JSON answer with a
boolean `needsSetup` (and an optional `message`) shows the **Needs setup** box
and makes **Set up** the primary button. Any other answer shows nothing.

## Machine control

Where Decaid reports `machineControl` for a plugin in `GET /api/v1/plugins`,
the page shows an **Allow machine control** switch. Turning it on asks for
confirmation, then sends `PUT /api/v1/plugins/<id>/machine-control`
`{"granted": true}`. A refused write (extension protection) puts the switch back
and points to Decaid. Hosts without the field show no switch.

## Return to Streamline settings

The **Open** link includes a URL-encoded `returnTo` query parameter containing
the current skin address with `page=settings`. The host, actual skin port,
path and other query parameters are preserved. Streamline restores the selected
Extensions category through its existing settings-location state.

For example, a skin running at `http://localhost:24803/index.html?page=settings`
opens the plugin at:

```text
http://localhost:8080/api/v1/plugins/example.reaplugin/ui?returnTo=http%3A%2F%2Flocalhost%3A24803%2Findex.html%3Fpage%3Dsettings
```

Plugin UIs can read `returnTo` with `new URLSearchParams(location.search)` and
use it for their Back link after validating it. Accept only the intended
HTTP(S) skin host/origin, reject embedded credentials, and provide a fallback
for direct visits. Do not assume port 3000 is the skin's actual origin or rely
on `document.referrer` to retain the settings route.

Plugins that do not use `returnTo` can ignore the parameter. The plugin still
must declare an HTTP `ui` endpoint to receive an **Open** link.
