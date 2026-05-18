/**
 * <print-element-button>
 *
 * A zero-dependency custom element that prints a single DOM element and its
 * descendants in an isolated iframe, leaving the host page completely untouched.
 *
 * Basic usage:
 *   <print-element-button target="#my-element">Print</print-element-button>
 *
 * Attributes:
 *   target       – CSS selector for the element to print (default: parentElement).
 *                  Resolved at click time, so late DOM changes are picked up automatically.
 *   page-size    – Passed to @page { size }. Accepts "letter", "legal", "a4", or
 *                  explicit dimensions like "8.5in 11in" (default: "letter").
 *   margins      – Passed to @page { margin }. Any CSS length or shorthand,
 *                  e.g. "0.75in" or "1in 0.5in" (default: "0").
 *   print-title  – Title shown in the print dialog and used as the default PDF
 *                  filename. Inherits the page title if omitted.
 *   aria-label   – Forwarded to the inner <button>. Use this when the label is
 *                  icon-only so screen readers have an accessible name.
 *   class        – Forwarded to the inner <button>, so site button styles apply
 *                  naturally: <print-element-button class="btn-primary">.
 *
 * Label:
 *   Content between the tags becomes the button label. Whitespace-only content
 *   is ignored and falls back to the default "🖨️ Print" label.
 *   Important: set label content *before* appending to the DOM. To update it
 *   after connect, target the inner button: el.querySelector('button').textContent.
 *
 * Methods:
 *   print()   – Triggers the full print sequence. Returns a Promise that resolves
 *               after the dialog closes (afterprint), or rejects with
 *               DOMException('InvalidStateError') if already printing, or with an
 *               Error if target resolution or iframe setup fails.
 *   cancel()  – Aborts an in-flight print before the dialog opens. If called after
 *               print-start has fired, print-end still fires to balance the lifecycle.
 *
 * Events (all bubble and are composed, so they cross shadow DOM boundaries):
 *   print-start  – Fires once the iframe is ready and print() has been called on it.
 *                  Every print-start is guaranteed exactly one matching print-end.
 *   print-end    – Fires on afterprint, on the 60 s timeout, or when cancel() is
 *                  called after print-start. detail: null normally; { timedOut: true }
 *                  if the 60 s fallback fired.
 *   print-error  – Fires if preparation fails. detail: { error: Error }.
 */

/**
 * Serializes CSSStyleSheet objects (adoptedStyleSheets) to a plain CSS string.
 *
 * adoptedStyleSheets live outside the DOM tree and are invisible to cloneNode,
 * so they must be walked and inlined manually into the print document.
 * Cross-origin sheets throw SecurityError on cssRules access — those are caught
 * and skipped because the cloned <link> tag will load them in the iframe anyway.
 *
 * Exported so the unit tests can exercise it directly.
 */
export function serializeAdopted(sheets) {
  if (!sheets?.length) return '';
  return [...sheets].map(sheet => {
    try {
      return [...sheet.cssRules].map(r => r.cssText).join('\n');
    } catch {
      return '';
    }
  }).join('\n');
}

/**
 * Recursively collects every open shadow root reachable from `el`.
 *
 * Passed to getHTML({ shadowRoots }) so the browser serializes all open shadow
 * roots regardless of whether they were created with { serializable: true }.
 * Without this, only explicitly-serializable shadow roots would appear in the
 * print output. Recursion into each shadow root handles shadow-in-shadow nesting.
 */
function collectShadowRoots(el, acc = []) {
  if (el.shadowRoot) {
    acc.push(el.shadowRoot);
    collectShadowRoots(el.shadowRoot, acc);
  }
  el.querySelectorAll('*').forEach(child => {
    if (child.shadowRoot) collectShadowRoots(child, acc);
  });
  return acc;
}

/**
 * Builds the complete HTML string that will be loaded into the print iframe.
 *
 * The strategy: clone the live <html> element (which brings every <link> and
 * <style> tag along for free), strip all scripts, replace <body> with only the
 * serialized target content, then inject the @page rule and any adopted
 * stylesheets that survive only as JavaScript objects and won't survive cloning.
 *
 * Scripts in the cloned head are stripped because they'd re-run in the iframe
 * (analytics, component registrations, etc.) and we don't need them — shadow DOM
 * is already captured statically by getHTML. Scripts that are part of the target
 * element's own HTML are preserved for the outerHTML fallback path.
 */
function buildPrintDocument(target, options = {}) {
  const {
    pageSize = 'letter',
    margins = '0',
    printTitle = '',
  } = options;

  const docClone = document.documentElement.cloneNode(true);
  docClone.querySelectorAll('script').forEach(el => el.remove());

  // Collect all shadow roots so getHTML can serialize them even if they were
  // not created with { serializable: true }.
  const shadowRoots = collectShadowRoots(target);
  const targetHTML = target.getHTML?.({ serializableShadowRoots: true, shadowRoots }) ?? target.outerHTML;
  const body = docClone.querySelector('body');
  body.innerHTML = targetHTML;

  // Lazy images never enter the viewport in an offscreen 1×1 iframe, so they
  // would never load. Rewrite them eagerly before the iframe loads.
  body.querySelectorAll('img[loading="lazy"]').forEach(img => img.setAttribute('loading', 'eager'));

  const head = docClone.querySelector('head');

  // Reset browser default body margin so @page margin is the only offset.
  const resetStyle = document.createElement('style');
  resetStyle.textContent = 'html,body{margin:0;padding:0;background:white;}';
  head.appendChild(resetStyle);

  const pageStyle = document.createElement('style');
  pageStyle.textContent = `@page { size: ${pageSize}; margin: ${margins}; }`;
  head.appendChild(pageStyle);

  // adoptedStyleSheets are JS-only objects — they don't appear in the DOM and
  // won't be captured by cloneNode. Serialize and inline them as <style> blocks.
  const adoptedCSS = [
    serializeAdopted(document.adoptedStyleSheets),
    serializeAdopted(target.shadowRoot?.adoptedStyleSheets),
  ].join('\n').trim();

  if (adoptedCSS) {
    const adoptedStyle = document.createElement('style');
    adoptedStyle.textContent = adoptedCSS;
    head.appendChild(adoptedStyle);
  }

  if (printTitle) {
    let titleEl = head.querySelector('title');
    if (!titleEl) {
      titleEl = document.createElement('title');
      head.appendChild(titleEl);
    }
    titleEl.textContent = printTitle;
  }

  return '<!DOCTYPE html>\n' + docClone.outerHTML;
}

/**
 * The <print-element-button> custom element.
 *
 * Renders a <button> in the light DOM (no shadow root) so host-page CSS reaches
 * it directly. Children between the tags become the button label; whitespace-only
 * content falls back to "🖨️ Print".
 *
 * All printing happens inside a hidden 1×1 px iframe that is created per session
 * and removed immediately after the dialog closes. The host page DOM is never
 * mutated — no flicker, no scroll jump, no class toggling.
 */
class PrintElementButton extends HTMLElement {
  #printing = false;
  #abort = null;
  #btn = null;
  #observer = null;

  constructor() {
    super();
    // Create the button in the light DOM so parent-page CSS reaches it naturally.
    // Classes on the host are forwarded to the button, enabling patterns like
    // <print-element-button class="btn-primary"> to pick up site button styles.
    this.#btn = document.createElement('button');
    this.#btn.type = 'button';
    this.#btn.textContent = '🖨️ Print'; // default label; replaced by children on first connect
  }

  connectedCallback() {
    if (!this.contains(this.#btn)) {
      // Move light-DOM children into the button, ignoring whitespace-only text nodes
      // so <print-element-button>   </print-element-button> keeps the default label.
      const children = [...this.childNodes];
      const hasMeaningful = children.some(n =>
        n.nodeType === Node.ELEMENT_NODE ||
        (n.nodeType === Node.TEXT_NODE && n.textContent.trim())
      );
      if (hasMeaningful) {
        this.#btn.textContent = '';
        children.forEach(n => this.#btn.appendChild(n));
      }
      this.appendChild(this.#btn);
    }
    this.#syncClasses();
    this.#observer = new MutationObserver(() => this.#syncClasses());
    this.#observer.observe(this, { attributes: true, attributeFilter: ['class', 'aria-label'] });
    this.#btn.addEventListener('click', this.#handleClick);
  }

  disconnectedCallback() {
    this.#btn.removeEventListener('click', this.#handleClick);
    this.#observer?.disconnect();
    this.#observer = null;
    this.cancel();
  }

  // Forward class and aria-label from the host element to the inner button.
  // class lets site-wide button styles apply via <print-element-button class="...">.
  // aria-label is needed when the label is icon-only and has no visible text.
  #syncClasses() {
    this.#btn.className = this.className;
    const label = this.getAttribute('aria-label');
    label !== null
      ? this.#btn.setAttribute('aria-label', label)
      : this.#btn.removeAttribute('aria-label');
  }

  #handleClick = () => { this.print(); };

  get #target() {
    const sel = this.getAttribute('target');
    return sel ? document.querySelector(sel) : this.parentElement;
  }

  /**
   * Triggers the print sequence programmatically.
   * Equivalent to clicking the button.
   * @returns {Promise<void>} Resolves after the print dialog closes.
   */
  print() {
    // Guard against overlapping calls — the button is also disabled during printing,
    // but programmatic callers can still call print() concurrently.
    if (this.#printing) {
      return Promise.reject(new DOMException('Print already in progress', 'InvalidStateError'));
    }

    const target = this.#target;
    if (!target) {
      const err = new Error('Target element not found');
      this.#emitError(err);
      return Promise.reject(err);
    }

    this.#printing = true;
    this.#btn.disabled = true;
    this.#abort = new AbortController();
    const { signal } = this.#abort;

    return this.#runPrint(target, signal).finally(() => {
      this.#printing = false;
      this.#btn.disabled = false;
      this.#abort = null;
    });
  }

  async #runPrint(target, signal) {
    let iframe;
    let printStarted = false;
    try {
      const html = buildPrintDocument(target, {
        pageSize: this.getAttribute('page-size') ?? 'letter',
        margins: this.getAttribute('margins') ?? '0',
        printTitle: this.getAttribute('print-title') ?? '',
      });

      iframe = document.createElement('iframe');
      iframe.setAttribute('aria-hidden', 'true');
      iframe.style.cssText = 'position:fixed;left:-10000px;width:1px;height:1px;border:0;opacity:0;';
      // Set srcdoc before appending so the browser skips the about:blank navigation
      // and fires exactly one load event (for the srcdoc content).
      iframe.srcdoc = html;

      await new Promise((resolve, reject) => {
        const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
        signal.addEventListener('abort', onAbort, { once: true });
        iframe.addEventListener('load', () => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        }, { once: true });
        document.body.appendChild(iframe);
      });

      if (signal.aborted) return;

      const iframeDoc = iframe.contentDocument;
      const iframeWin = iframe.contentWindow;

      // Race fonts.ready against a 10 s cap so a stalled font load can't hang
      // print prep indefinitely (the 60 s timeout only covers the dialog phase).
      await Promise.race([
        iframeDoc.fonts.ready,
        new Promise(r => setTimeout(r, 10_000)),
      ]);
      // Decode all images before printing so none appear blank. Rejections are
      // swallowed — a broken image shouldn't prevent the rest from printing.
      await Promise.all([...iframeDoc.querySelectorAll('img')].map(img =>
        img.decode().catch(() => null)
      ));

      if (signal.aborted) return;

      printStarted = true;
      this.dispatchEvent(new CustomEvent('print-start', { bubbles: true, composed: true }));

      await new Promise((resolve, reject) => {
        const onAbort = () => {
          clearTimeout(timeout);
          reject(new DOMException('Aborted', 'AbortError'));
        };
        signal.addEventListener('abort', onAbort, { once: true });

        // 60 s fallback: afterprint doesn't fire in every environment (e.g. some
        // headless browsers, aggressive popup blockers). This ensures cleanup always runs.
        const timeout = setTimeout(() => {
          signal.removeEventListener('abort', onAbort);
          this.dispatchEvent(new CustomEvent('print-end', {
            bubbles: true,
            composed: true,
            detail: { timedOut: true },
          }));
          resolve();
        }, 60_000);

        iframeWin.addEventListener('afterprint', () => {
          clearTimeout(timeout);
          signal.removeEventListener('abort', onAbort);
          this.dispatchEvent(new CustomEvent('print-end', { bubbles: true, composed: true }));
          resolve();
        }, { once: true });

        try {
          // focus() is required for Safari; harmless elsewhere.
          iframeWin.focus();
          iframeWin.print();
        } catch (err) {
          clearTimeout(timeout);
          signal.removeEventListener('abort', onAbort);
          reject(err);
        }
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        // cancel() was called — if print-start already fired, emit print-end to
        // keep the lifecycle balanced (every start has exactly one end).
        if (printStarted) {
          this.dispatchEvent(new CustomEvent('print-end', { bubbles: true, composed: true }));
        }
      } else {
        this.#emitError(err);
        throw err;
      }
    } finally {
      iframe?.remove();
    }
  }

  /**
   * Aborts an in-flight print before the dialog opens.
   * Safe to call at any time; a no-op if nothing is in progress.
   */
  cancel() {
    this.#abort?.abort();
  }

  #emitError(error) {
    this.dispatchEvent(new CustomEvent('print-error', {
      bubbles: true,
      composed: true,
      detail: { error },
    }));
  }
}

customElements.define('print-element-button', PrintElementButton);
