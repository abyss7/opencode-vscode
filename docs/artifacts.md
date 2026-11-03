# Artifacts

The client describes this contract to the model automatically. A fenced
`opencode-artifact` block contains a JSON object:

```json
{
  "schema": 1,
  "id": "latency",
  "version": 1,
  "title": "Measured latency",
  "kind": "chart",
  "chart": "line",
  "xLabel": "Concurrent requests",
  "yLabel": "Duration",
  "unit": "ms",
  "series": [{ "name": "Run 1", "values": [{ "x": 1, "y": 12 }, { "x": 2, "y": 18 }] }],
  "source": { "path": "bench/results.json", "line": 1 }
}
```

The numbers above illustrate the schema; actual charts must use provided or measured
data. Axis labels and units are required (use `""` for dimensionless values). Numeric
x/y coordinates, negative values and multiple named series are supported. `chart`
can be `line` or `bar`; exact values remain available in a sortable data table.

All kinds share `schema`, `id`, `version`, `title` and optional `source`:

| kind | Fields |
| --- | --- |
| `markdown` | `content`: Markdown text |
| `mermaid` | `content`: Mermaid source |
| `table` | `data`: array of records |
| `diff` | `path`, `oldText` (null for creation), `newText` |
| `image` | `dataUrl`: base64 PNG, JPEG, WebP or GIF |
| `chart` | `chart`, `xLabel`, `yLabel`, `unit`, `series` |

Use a stable id and increase the positive integer version for each revision. A
version is immutable; conflicting definitions remain visible as an error and source.
Invalid or unsupported blocks keep their JSON instead of disappearing.

The artifact button in the answer opens a persistent side panel (stacked above the
composer on narrow views). The panel has object/version selectors, Preview/Source,
JSON export, and links to the originating answer and optional source file. The panel
follows new revisions when viewing the latest one; older selected versions stay put.
The transcript is the durable store: history replay rebuilds artifacts and versions,
while the webview state keeps panel selection. Export asks for a destination through
VS Code and writes the exact JSON, including embedded image data.
