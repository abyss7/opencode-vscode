# Browser UI checks

The fixture loads the actual `media/chat.html`, CSS and JavaScript in Chromium,
with the production Content Security Policy. Only the VS Code host bridge and
theme variables are substituted. No OpenCode service or model calls are needed.

```sh
npm ci
npx playwright install chromium
npm run test:ui
```

Playwright 1.56.1 is pinned to support Ubuntu 20.04 development hosts. CI uses
the same browser revision. On a new Linux host, Playwright may report missing
system libraries; CI installs them with `playwright install --with-deps chromium`.

The four projects cover light/dark themes at 380px and 1100px. Tests check real
keyboard input, host messages, Markdown, file links, tool/plan expansion, forms,
permissions, scrolling and composer geometry. Browser exceptions, failed
resources and CSP violations fail the test.

Each test attaches a screenshot; failures also retain a trace. The HTML report
is at `test-results/ui/report/index.html`. Set `OPENCODE_UI_OUTPUT` to relocate
all output, for example to `$OUT/ui`. Screenshots are for visual review, not
pixel-golden assertions: system font differences must not silently redefine a
baseline. Assertions verify behavior and geometry independently of the images.

```sh
npm run test:ui -- --project=dark-380
npx playwright show-report test-results/ui/report
```

Add new scenarios through `chat.send()` / `chat.update()`, using the same
messages as the extension host. `chat.snapshot(name)` records intermediate
states. This tests webview behavior; native VS Code commands still need their
host-side tests and an extension smoke check when changed.

## Bundled renderers

Browser dependencies are pinned in `package-lock.json`. Edit
`src/webview/rich-text.js`, then run `npm run build:ui` and commit the generated
`media/rich-text.js` and its license file with the source. The extension and
offline host tests use this checked-in bundle without Node dependencies at
runtime. The webview never fetches rendering libraries from a CDN.
