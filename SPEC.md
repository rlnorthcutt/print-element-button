# `<print-element-button>` Component Spec

A zero-dependency custom element that prints a single DOM element and its descendants, isolated from the rest of the page. Designed to pair with `<stapler>` so a user can print one document widget on a page that contains other content.

## Goal

Provide a small, reusable button component that, when clicked, prints just one element. The button should:

- Have no external dependencies
- Work with custom elements that use shadow DOM (specifically `<stapler>`)
- Preserve visual fidelity, including any 8.5x11 page layout the target produces
- Not affect the host page (no flicker, no scroll changes, no DOM mutation outside the iframe)
- Snapshot the target's content at click time; subsequent changes are not reflected in the print output until the button is clicked again
- Clean up after itself, whether the user prints or cancels

## Approach

The implementation is conceptually simple: remove everything from the DOM except the target element, then print. The cleanest way to do this without disturbing the host page is to construct that "stripped" DOM inside an offscreen iframe and call `print()` on the iframe.

Three other approaches were considered and rejected:

**CSS `@media print` plus body class.** Add a class to `<body>` on click, hide everything except the target via CSS. Fragile with fixed positioning, modals, and any element that escapes the simple ancestor chain. Skip.

**`window.open()`.** Pops a window, browsers may block it, the user gets a window flash, Safari is inconsistent. Skip.

**Iframe (selected).** Predictable across browsers, no popup, no impact on the host page. The dialog closes back to the original page seamlessly.

## Component API

### Tag

```html
<print-element-button target="#stapler-1">Print</print-element-button>
```

### Attributes

| Attribute | Type | Default | Description |
|-----------|------|---------|-------------|
| `target` | CSS selector | parent element | Element to print. If omitted, uses the component's parent. |
| `page-size` | string | `letter` | Passed to `@page size`. Accepts `letter`, `legal`, `a4`, or explicit dimensions like `8.5in 11in`. |
| `margins` | string | `0` | Passed to `@page margin`. |
| `title` | string | inherits page title | Title shown in the print dialog and used as the default PDF filename. |

### Slotted content

Whatever sits between the tags becomes the button label. Falls back to "Print" if empty.

```html
<print-element-button target="#doc">
  <svg>...</svg> Print as PDF
</print-element-button>
```

### Methods

- `print()`: programmatic trigger, returns a promise that resolves on `afterprint` or rejects on error
- `cancel()`: aborts in-flight print prep before the dialog opens

### Events

- `print-start`: fires once the iframe is ready and `print()` has been called on it
- `print-end`: fires on `afterprint`, regardless of whether the user printed or cancelled
- `print-error`: fires if anything in the prep sequence fails

## Implementation Strategy

### Building the print document

The mental model: clone the page, strip scripts, replace the body with just the target.

```js
function buildPrintDocument(target, options) {
  // 1. Clone the entire <html> element from the host page
  const docClone = document.documentElement.cloneNode(true);

  // 2. Strip all scripts. They'd re-run in the iframe and we don't need them.
  docClone.querySelectorAll('script').forEach(s => s.remove());

  // 3. Serialize the target, including shadow DOM if present
  const targetHTML = target.getHTML?.({ serializableShadowRoots: true })
                  ?? target.outerHTML;

  // 4. Replace body content with just the serialized target
  const body = docClone.querySelector('body');
  body.innerHTML = targetHTML;

  // 5. Inject @page rule and inline adopted stylesheets
  const head = docClone.querySelector('head');
  appendPageStyle(head, options);
  appendAdoptedStyles(head, target);

  // 6. Override title if requested
  if (options.title) setTitle(head, options.title);

  return '<!DOCTYPE html>\n' + docClone.outerHTML;
}
```

The cloned head naturally brings every `<link>` and `<style>` tag from the host page, including font links, meta tags, and inline styles. Shadow DOM `<style>` tags inside the target ride along via `getHTML`'s declarative shadow DOM serialization.

### Adopted stylesheets

`document.adoptedStyleSheets` and `target.shadowRoot?.adoptedStyleSheets` are CSSStyleSheet objects attached via JavaScript. They don't appear in the DOM tree and won't be captured by cloning. If they're in use, walk their `cssRules` and inline as `<style>` blocks:

```js
function serializeAdopted(sheets) {
  if (!sheets?.length) return '';
  return [...sheets].map(sheet => {
    try {
      return [...sheet.cssRules].map(r => r.cssText).join('\n');
    } catch (e) {
      // SecurityError on cross-origin sheets; the <link> tag covers them
      return '';
    }
  }).join('\n');
}
```

For shadow root adopted stylesheets, dumping them into the iframe head is fine even though it loses scoping. The iframe contains only one component's content, so there's nothing else for the rules to bleed onto.

### Print sequence

```
1. Create iframe: position: fixed; left: -10000px; width: 1px; height: 1px; border: 0; opacity: 0
2. Append to document.body
3. Set iframe.srcdoc to assembled document
4. Await iframe 'load' event
5. Await iframe.contentDocument.fonts.ready
6. Await Promise.all(images.map(img => img.decode().catch(() => null)))
7. iframe.contentWindow.focus()
8. iframe.contentWindow.print()
9. Listen once for iframe.contentWindow 'afterprint'
10. Remove iframe from DOM
```

`focus()` is required for Safari and harmless elsewhere. `img.decode()` rejections are swallowed so a broken image doesn't block printing.

### Cleanup

`afterprint` fires whether the user printed or cancelled in every modern browser. Add a 60-second timeout fallback in case it doesn't. Track an in-flight flag on the component to ignore duplicate clicks while a print is pending.

## Stapler-specific notes

Two things to verify when integrating with `<stapler>`:

**Layout units.** If stapler styles its pages with viewport units (`vh`, `vw`), they'll compute against the iframe viewport rather than 8.5x11. The `@page` rule controls the printer output, but the iframe's in-document layout is what gets rasterized. Stapler should use absolute units (`in`, `cm`, `mm`) for page dimensions in its CSS.

**Shadow DOM styles.** If stapler attaches CSS via `shadowRoot.adoptedStyleSheets`, the adopted-styles step above handles it. If it uses a `<style>` tag inside the shadow root, `getHTML` captures it automatically. Either pattern works.

## Edge cases

**Cross-origin stylesheets.** Accessing `cssRules` throws `SecurityError`. Catch and rely on the cloned `<link>` tag instead. The CSS still loads in the iframe.

**Lazy-loaded images.** `loading="lazy"` images won't load in an offscreen iframe because they never enter view. Walk the cloned content and rewrite `loading="lazy"` to `loading="eager"` before injecting.

**Web fonts.** `document.fonts.ready` in the iframe waits for them, but only if the font is referenced via CSS that made it into the iframe. The head clone handles this for `<link>` and `@font-face` rules.

**Existing `@media print` rules in host styles.** These apply in the iframe too since those stylesheets are copied. Usually desired (stapler likely has its own print rules).

**Form state, scroll position, canvas content.** These don't serialize via outerHTML or getHTML. Acceptable for stapler, which is static. Worth documenting as a known limitation.

**Closed shadow roots.** `getHTML({ serializableShadowRoots: true })` only serializes open shadow roots and shadow roots explicitly marked serializable. Stapler should use open shadow DOM.

**User clicks print twice quickly.** The in-flight flag handles this. The button can also visually disable itself between `print-start` and `print-end`.

**Print blocked by browser.** Some hardened environments block programmatic `print()`. Catch the error, fire `print-error`, clean up.

## Phased build plan

**Phase 1: working component.** Custom element registration, target resolution, hidden iframe, clone-and-strip approach for the document, `getHTML` with `outerHTML` fallback for the target, adopted stylesheet inlining, `@page` rule, font/image readiness, `print()` plus `afterprint` cleanup, basic error handling. This is the entire useful product.

**Phase 2: polish.** All four attributes (`target`, `page-size`, `margins`, `title`), slotted button content, custom events, programmatic `print()` method, in-flight flag, lazy-image rewrite. This is what makes it production-ready.

## File structure

Single file, no build step.

```
print-element-button.js   // ~200 lines, self-contained
```

Distribution:

```html
<script type="module" src="/path/to/print-element-button.js"></script>
```

The script registers `<print-element-button>` automatically on import.

## Browser support

- Chrome 125+ (May 2024)
- Firefox 128+ (July 2024)
- Safari 17.4+ (March 2024)

Older browsers fall back to `target.outerHTML` and lose shadow DOM serialization. The component still works for non-shadow-DOM targets.

## Decisions

These are locked in based on the design review:

1. **Snapshot on click.** Content is captured when the button is clicked. Subsequent changes to the target don't affect the print output. To print updates, click again.

2. **Clone-and-strip styles.** The iframe document is built by cloning the page's `<html>`, removing scripts, replacing the body with the serialized target, and inlining adopted stylesheets. This is the "remove everything except the target" model expressed as a build step instead of a destructive DOM operation on the live page.

3. **No print-only CSS slots.** The component is a clean point solution. Headers, footers, page numbers, and any other print chrome are stapler's responsibility. This component does plumbing only.
