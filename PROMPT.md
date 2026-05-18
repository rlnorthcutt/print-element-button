# `<print-element-button>` — LLM Reference

Use this as a cut-paste context block when asking an LLM to help integrate or extend `<print-element-button>`.

---

## What it is

`<print-element-button>` is a zero-dependency custom element. Drop it on a page and it prints one DOM element (and its descendants) in a hidden iframe, leaving everything else on the page untouched. No build step required.

## Install

```html
<!-- CDN (no install) -->
<script type="module" src="https://cdn.jsdelivr.net/gh/rlnorthcutt/print-element-button@main/dist/print-element-button.min.js"></script>

<!-- npm -->
<script type="module">import 'print-element-button';</script>
```

## Core pattern

```html
<div id="report"><!-- content to print --></div>

<print-element-button target="#report">Print Report</print-element-button>
```

The element between the tags is the button label. Empty → defaults to "🖨️ Print".

## Attributes

| Attribute     | Default        | Notes |
|---------------|----------------|-------|
| `target`      | `parentElement`| CSS selector; resolved at click time via `querySelector` (first match). Omit to print the parent element. |
| `page-size`   | `letter`       | `@page { size }` — `letter`, `legal`, `a4`, or `8.5in 11in`. |
| `margins`     | `0`            | `@page { margin }` — any CSS length, e.g. `0.75in`. |
| `print-title` | page title     | Sets `<title>` in the print doc; appears in the dialog and as the default PDF filename. |
| `class`       | —              | Forwarded to inner `<button>` — site button styles apply automatically. |
| `aria-label`  | —              | Forwarded to inner `<button>` — required when the label is icon-only. |

## Methods

```js
const peb = document.querySelector('print-element-button');

// Programmatic print — same as clicking the button.
// Resolves after dialog closes (afterprint); rejects on error or if already printing.
await peb.print();

// Cancel an in-flight print before the dialog opens.
// No-op if nothing is in progress.
peb.cancel();
```

## Events

All events bubble and are composed (cross shadow DOM).

```js
peb.addEventListener('print-start', () => { /* iframe ready, dialog opening */ });
peb.addEventListener('print-end',   e  => { /* dialog closed; e.detail = null or { timedOut: true } */ });
peb.addEventListener('print-error', e  => { /* prep failed; e.detail = { error: Error } */ });
```

`print-start` always has exactly one matching `print-end`, no matter how the session ends.

## Key behaviors

- **Snapshot on click.** Content is captured at the moment `print()` is called. Later DOM changes don't affect the output.
- **Button state.** The inner `<button>` is disabled automatically while printing; re-enabled in `.finally()`.
- **In-flight guard.** Calling `print()` while already printing rejects with `DOMException('InvalidStateError')`.
- **Disconnect cancels.** Removing the element from the DOM cancels any in-flight print automatically.
- **60 s timeout.** If `afterprint` never fires (some headless environments), `print-end` fires with `{ timedOut: true }` after 60 seconds.
- **Label mutation.** Set label content *before* appending to the DOM. After connect, mutate `el.querySelector('button')` directly — don't set `el.textContent` or `el.innerHTML`, as that would replace the inner button.

## How the print document is built

1. `document.documentElement.cloneNode(true)` — captures all `<link>` and `<style>` tags.
2. `<script>` tags stripped from the cloned head. Target-element scripts preserved.
3. Target serialized via `getHTML({ serializableShadowRoots: true, shadowRoots })`, falling back to `outerHTML`. Shadow roots collected recursively so nested shadow-in-shadow is captured.
4. `document.adoptedStyleSheets` and `shadowRoot.adoptedStyleSheets` inlined as `<style>` blocks.
5. `loading="lazy"` images rewritten to `loading="eager"`.
6. `@page { size; margin }` rule injected.
7. Loaded into a 1×1 px offscreen iframe via `srcdoc`. Fonts and images awaited, then `contentWindow.print()` called. Iframe removed on `afterprint`.

## Limitations

- **Safari 17.x** — no `getHTML`; shadow root internals are lost. Light DOM prints fine. Safari 18+ has full support.
- **Form state, canvas, scroll position** — not serialized by `getHTML` / `outerHTML`.
- **Closed shadow roots** — not captured. Use open shadow DOM.
- **Viewport units** — `vh`/`vw` resolve to 1 px in the hidden iframe. Use `in`, `cm`, or `mm` for page-dimension CSS.
