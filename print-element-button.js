// Named exports for testing
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

function buildPrintDocument(target, options = {}) {
  const {
    pageSize = 'letter',
    margins = '0',
    title = '',
  } = options;

  const docClone = document.documentElement.cloneNode(true);
  docClone.querySelectorAll('script').forEach(el => el.remove());

  const targetHTML = target.getHTML?.({ serializableShadowRoots: true }) ?? target.outerHTML;
  const body = docClone.querySelector('body');
  body.innerHTML = targetHTML;
  body.querySelectorAll('img[loading="lazy"]').forEach(img => img.setAttribute('loading', 'eager'));

  const head = docClone.querySelector('head');

  const pageStyle = document.createElement('style');
  pageStyle.textContent = `@page { size: ${pageSize}; margin: ${margins}; }`;
  head.appendChild(pageStyle);

  const adoptedCSS = [
    serializeAdopted(document.adoptedStyleSheets),
    serializeAdopted(target.shadowRoot?.adoptedStyleSheets),
  ].join('\n').trim();

  if (adoptedCSS) {
    const adoptedStyle = document.createElement('style');
    adoptedStyle.textContent = adoptedCSS;
    head.appendChild(adoptedStyle);
  }

  if (title) {
    let titleEl = head.querySelector('title');
    if (!titleEl) {
      titleEl = document.createElement('title');
      head.appendChild(titleEl);
    }
    titleEl.textContent = title;
  }

  return '<!DOCTYPE html>\n' + docClone.outerHTML;
}

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
      // Move any existing light-DOM children (label content) into the button.
      const children = [...this.childNodes];
      if (children.length > 0) {
        this.#btn.textContent = '';
        children.forEach(n => this.#btn.appendChild(n));
      }
      this.appendChild(this.#btn);
    }
    this.#syncClasses();
    this.#observer = new MutationObserver(() => this.#syncClasses());
    this.#observer.observe(this, { attributes: true, attributeFilter: ['class'] });
    this.#btn.addEventListener('click', this.#handleClick);
  }

  disconnectedCallback() {
    this.#btn.removeEventListener('click', this.#handleClick);
    this.#observer?.disconnect();
    this.#observer = null;
    this.cancel();
  }

  #syncClasses() {
    this.#btn.className = this.className;
  }

  #handleClick = () => { this.print(); };

  get #target() {
    const sel = this.getAttribute('target');
    return sel ? document.querySelector(sel) : this.parentElement;
  }

  print() {
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
        title: this.getAttribute('title') ?? '',
      });

      iframe = document.createElement('iframe');
      iframe.setAttribute('aria-hidden', 'true');
      iframe.style.cssText = 'position:fixed;left:-10000px;width:1px;height:1px;border:0;opacity:0;';
      document.body.appendChild(iframe);

      await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        iframe.addEventListener('load', resolve, { once: true });
        iframe.srcdoc = html;
      });

      if (signal.aborted) return;

      const iframeDoc = iframe.contentDocument;
      const iframeWin = iframe.contentWindow;

      await iframeDoc.fonts.ready;
      await Promise.all([...iframeDoc.querySelectorAll('img')].map(img =>
        img.decode().catch(() => null)
      ));

      if (signal.aborted) return;

      printStarted = true;
      this.dispatchEvent(new CustomEvent('print-start', { bubbles: true, composed: true }));

      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.dispatchEvent(new CustomEvent('print-end', {
            bubbles: true,
            composed: true,
            detail: { timedOut: true },
          }));
          resolve();
        }, 60_000);

        iframeWin.addEventListener('afterprint', () => {
          clearTimeout(timeout);
          this.dispatchEvent(new CustomEvent('print-end', { bubbles: true, composed: true }));
          resolve();
        }, { once: true });

        signal.addEventListener('abort', () => {
          clearTimeout(timeout);
          reject(new DOMException('Aborted', 'AbortError'));
        });

        try {
          iframeWin.focus();
          iframeWin.print();
        } catch (err) {
          clearTimeout(timeout);
          reject(err);
        }
      });
    } catch (err) {
      if (err.name === 'AbortError') {
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
