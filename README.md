# `<print-element-button>`

A zero-dependency custom element that prints a single DOM element and its descendants in an isolated iframe, leaving the rest of the page untouched.

Designed to pair with `<stapler>` but works with any element.

## Installation

Drop the file in, import it as a module:

```html
<script type="module" src="/path/to/print-element-button.js"></script>
```

No build step required.

## Usage

```html
<div id="invoice">
  <!-- ... invoice content ... -->
</div>

<print-element-button target="#invoice">Print Invoice</print-element-button>
```

The content between the tags is the button label. Falls back to "Print" if empty.

```html
<print-element-button target="#invoice">
  <svg aria-hidden="true">...</svg>
  Save as PDF
</print-element-button>
```

## Attributes

| Attribute   | Default        | Description |
|-------------|----------------|-------------|
| `target`    | parent element | CSS selector for the element to print. If omitted, uses `parentElement`. |
| `page-size` | `letter`       | Passed to `@page { size: ... }`. Accepts `letter`, `legal`, `a4`, or explicit dimensions like `8.5in 11in`. |
| `margins`   | `0`            | Passed to `@page { margin: ... }`. |
| `title`     | page title     | Title shown in the print dialog and used as the default PDF filename. |

## Methods

### `print() → Promise<void>`

Programmatic trigger. Returns a promise that resolves after `afterprint` fires (i.e., after the user closes the print dialog — whether they printed or cancelled).

```js
const btn = document.querySelector('print-element-button');
await btn.print();
console.log('dialog closed');
```

Rejects with a `DOMException('InvalidStateError')` if called while a print is already in progress. Rejects with an `Error` if target resolution or iframe setup fails (and also fires `print-error`).

### `cancel() → void`

Aborts an in-flight print sequence. If called before the dialog opens, the `print()` promise resolves silently with no events dispatched. If called after `print-start` has already fired, `print-end` is still dispatched — the lifecycle is always balanced.

## Events

All events bubble and are composed (cross shadow DOM boundaries).

| Event         | Fires when | `detail` |
|---------------|-----------|----------|
| `print-start` | The iframe is ready and `print()` has been called on it | `null` |
| `print-end`   | `afterprint` fires, or the 60-second timeout is reached, or `cancel()` is called after `print-start` | `null` normally; `{ timedOut: true }` on timeout |
| `print-error` | Preparation fails (target not found, `print()` blocked by browser, etc.) | `{ error: Error }` |

`print-start` is always followed by exactly one `print-end`, regardless of how the session ends.

```js
document.querySelector('print-element-button').addEventListener('print-error', e => {
  console.error('Print failed:', e.detail.error);
});
```

## How it works

On click:

1. `document.documentElement` is cloned, capturing all `<link>` and `<style>` tags.
2. All `<script>` elements are stripped from the *cloned document's head* (component registrations, analytics, etc.). Scripts that are part of the target element's own content are preserved — some components need them to render correctly in the `outerHTML` fallback path.
3. The target element is serialized via `getHTML({ serializableShadowRoots: true })` (falling back to `outerHTML` on browsers without that API) and placed as the sole body content.
4. Adopted stylesheets (`document.adoptedStyleSheets` and `shadowRoot.adoptedStyleSheets`) are inlined as `<style>` blocks since they don't appear in the DOM tree.
5. An `@page` rule is injected using the `page-size` and `margins` attributes.
6. The assembled HTML is loaded into a 1 × 1 px off-screen iframe via `srcdoc`.
7. Once fonts and images are ready, `iframe.contentWindow.print()` is called.
8. On `afterprint`, the iframe is removed and state is reset.

The host page DOM is never mutated. Content is snapshotted at click time.

## Browser support

| Browser | Minimum version | Shadow DOM serialization |
|---------|----------------|--------------------------|
| Chrome  | 125+ (May 2024) | ✓ via `getHTML` |
| Firefox | 128+ (July 2024) | ✓ via `getHTML` |
| Safari  | 17.4+ (March 2024) | ✗ — falls back to `outerHTML` |

The component works on Safari 17.4+; shadow DOM content is simply not captured (the element's light DOM and any slotted content will be present, but shadow root internals will not). `getHTML()` is not yet shipped in Safari as of this writing.

## Known limitations

- **Shadow DOM on Safari** — `getHTML` is unavailable; shadow root content is lost. Non-shadow content prints fine.
- **Form state, scroll position, canvas content** — these do not serialize via `outerHTML` / `getHTML`. Static content only.
- **Closed shadow roots** — `getHTML` only serializes open shadow roots (or those explicitly marked `serializable`). Use open shadow DOM.
- **Viewport units in target styles** — `vh`/`vw` compute against the iframe viewport (1 px). Use absolute units (`in`, `cm`, `mm`) for page-dimension CSS.
- **Lazy-loaded images** — `loading="lazy"` is automatically rewritten to `loading="eager"`, but images not yet fetched in the host page may still be absent.

## FAQ

**What if the `target` selector matches more than one element?**

`querySelector` always returns the **first match in document order**. To print a specific one of several matching elements, use a more specific selector (e.g. `#invoice` rather than `.invoice`).

**When is the target element resolved?**

At print time — when the button is clicked or `print()` is called programmatically. If the target element is swapped or removed between clicks, the next click picks up the current state. This is by design: the component snapshots content at the moment of user intent.

**Will `<stapler-doc>` (or other custom elements) render in the print output?**

On Chrome and Firefox: yes. `getHTML({ serializableShadowRoots: true })` serializes the rendered shadow DOM as declarative shadow DOM HTML, so the printed document contains the fully-rendered component output without needing JavaScript to re-run.

On Safari: `outerHTML` is used instead, which captures only the light DOM. If the component renders entirely in its shadow root, the output will be empty or unstyled. This is a known Safari limitation.

**What happens to `<script>` tags?**

Scripts in the cloned document head (component registrations, analytics, etc.) are stripped. Scripts that are part of the target element's own HTML content are preserved. On the `getHTML` path this rarely matters since shadow DOM is captured statically; on the `outerHTML` path preserving target scripts gives components a chance to initialize.

**What if `cancel()` is called while the print dialog is already open?**

`print-end` still fires. Every `print-start` is guaranteed to be followed by exactly one `print-end`. The dialog may or may not be dismissed immediately depending on the browser — removing the iframe while the dialog is open is browser-dependent — but the component's event lifecycle is always consistent.

**What if `print()` is called while a print is already in progress?**

It rejects immediately with a `DOMException('InvalidStateError')`. The in-flight print is not affected. The button is automatically disabled during printing, so this only matters for programmatic callers.

## Development

```bash
npm test              # run tests once
npm run test:watch    # re-run on change
npm run test:coverage
```

Tests run in jsdom via [Vitest](https://vitest.dev). The component itself has no runtime dependencies.
