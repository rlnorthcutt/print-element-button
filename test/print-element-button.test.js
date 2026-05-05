import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { serializeAdopted } from '../print-element-button.js';

// One setTimeout(0) tick drains the microtask queue before resuming.
const tick = () => new Promise(r => setTimeout(r, 0));

// ── Shared iframe mock infrastructure ─────────────────────────────────────────

let mockIframe;
let mockWindow;
let afterprintHandlers;

function installIframeSpy() {
  const origAppendChild = document.body.appendChild.bind(document.body);

  vi.spyOn(document.body, 'appendChild').mockImplementation((node) => {
    origAppendChild(node);

    if (node instanceof HTMLIFrameElement) {
      mockIframe = node;
      afterprintHandlers = [];

      mockWindow = {
        focus: vi.fn(),
        print: vi.fn(),
        addEventListener(event, handler) {
          if (event === 'afterprint') afterprintHandlers.push(handler);
        },
      };

      Object.defineProperty(node, 'contentDocument', {
        get() {
          return {
            fonts: { ready: Promise.resolve() },
            querySelectorAll() { return []; },
          };
        },
        configurable: true,
      });

      Object.defineProperty(node, 'contentWindow', {
        get() { return mockWindow; },
        configurable: true,
      });
    }

    return node;
  });
}

function fireLoad() {
  mockIframe?.dispatchEvent(new Event('load'));
}

function fireAfterprint() {
  afterprintHandlers?.forEach(h => h());
}

// ── serializeAdopted ──────────────────────────────────────────────────────────

describe('serializeAdopted', () => {
  it('returns empty string for null', () => {
    expect(serializeAdopted(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(serializeAdopted(undefined)).toBe('');
  });

  it('returns empty string for an empty array', () => {
    expect(serializeAdopted([])).toBe('');
  });

  it('serializes cssRules from a single sheet', () => {
    const sheet = { cssRules: [{ cssText: '.a { color: red; }' }] };
    expect(serializeAdopted([sheet])).toBe('.a { color: red; }');
  });

  it('serializes multiple rules within one sheet', () => {
    const sheet = {
      cssRules: [
        { cssText: '.a { color: red; }' },
        { cssText: '.b { color: blue; }' },
      ],
    };
    const result = serializeAdopted([sheet]);
    expect(result).toContain('.a { color: red; }');
    expect(result).toContain('.b { color: blue; }');
  });

  it('serializes rules across multiple sheets', () => {
    const sheets = [
      { cssRules: [{ cssText: '.a {}' }] },
      { cssRules: [{ cssText: '.b {}' }] },
    ];
    const result = serializeAdopted(sheets);
    expect(result).toContain('.a {}');
    expect(result).toContain('.b {}');
  });

  it('swallows SecurityError from cross-origin sheets', () => {
    const blocked = {
      get cssRules() {
        throw new DOMException('Blocked a frame', 'SecurityError');
      },
    };
    const good = { cssRules: [{ cssText: '.ok {}' }] };
    const result = serializeAdopted([blocked, good]);
    expect(result).toContain('.ok {}');
    expect(result).not.toContain('SecurityError');
  });
});

// ── Component registration ────────────────────────────────────────────────────

describe('PrintElementButton — registration', () => {
  it('registers as "print-element-button"', () => {
    expect(customElements.get('print-element-button')).toBeDefined();
  });

  it('can be instantiated via document.createElement', () => {
    const el = document.createElement('print-element-button');
    expect(el).toBeInstanceOf(HTMLElement);
  });
});

// ── Component rendering ───────────────────────────────────────────────────────

describe('PrintElementButton — rendering', () => {
  let el;

  beforeEach(() => {
    el = document.createElement('print-element-button');
    document.body.appendChild(el);
  });

  afterEach(() => {
    el.remove();
  });

  it('uses light DOM (no shadow root)', () => {
    expect(el.shadowRoot).toBeNull();
  });

  it('contains a <button> as a direct child', () => {
    expect(el.querySelector('button')).not.toBeNull();
  });

  it('button has type="button" to avoid form submission', () => {
    expect(el.querySelector('button').getAttribute('type')).toBe('button');
  });

  it('button is enabled by default', () => {
    expect(el.querySelector('button').disabled).toBe(false);
  });

  it('defaults to "🖨️ Print" label when no children provided', () => {
    expect(el.querySelector('button').textContent.trim()).toBe('🖨️ Print');
  });

  it('forwards host classes to the inner button', async () => {
    el.className = 'primary large';
    await Promise.resolve(); // MutationObserver callback fires as a microtask
    expect(el.querySelector('button').className).toBe('primary large');
  });
});

// ── Document assembly (checks srcdoc content) ─────────────────────────────────

describe('PrintElementButton — document assembly', () => {
  let el;
  let target;

  beforeEach(() => {
    target = document.createElement('div');
    target.id = 'asm-target';
    document.body.appendChild(target);

    el = document.createElement('print-element-button');
    el.setAttribute('target', '#asm-target');
    document.body.appendChild(el);

    installIframeSpy();
  });

  afterEach(async () => {
    el.cancel();
    await tick();
    vi.restoreAllMocks();
    el.remove();
    target.remove();
    mockIframe = null;
  });

  it('srcdoc starts with <!DOCTYPE html>', () => {
    el.print();
    expect(mockIframe.srcdoc).toMatch(/^<!DOCTYPE html>/i);
  });

  it('strips head scripts from the cloned document', () => {
    const script = document.createElement('script');
    script.src = 'https://example.com/tracker.js';
    document.head.appendChild(script);

    el.print();
    expect(mockIframe.srcdoc).not.toContain('tracker.js');

    script.remove();
  });

  it('preserves scripts that are part of the target element content', () => {
    target.innerHTML = '<script>window.__tracked = true;<\/script><p>Hi</p>';
    el.print();
    expect(mockIframe.srcdoc).toContain('__tracked');
  });

  it('body contains only the target content, not other page elements', () => {
    target.innerHTML = '<p>Print me</p>';
    const other = document.createElement('aside');
    other.id = 'not-printed';
    document.body.appendChild(other);

    el.print();
    expect(mockIframe.srcdoc).toContain('<p>Print me</p>');
    expect(mockIframe.srcdoc).not.toContain('id="not-printed"');

    other.remove();
  });

  it('injects a default @page rule with letter size and 0 margin', () => {
    el.print();
    expect(mockIframe.srcdoc).toContain('@page');
    expect(mockIframe.srcdoc).toContain('letter');
    expect(mockIframe.srcdoc).toContain('margin: 0');
  });

  it('respects the page-size attribute', () => {
    el.setAttribute('page-size', 'a4');
    el.print();
    expect(mockIframe.srcdoc).toContain('a4');
  });

  it('respects the margins attribute', () => {
    el.setAttribute('margins', '0.75in');
    el.print();
    expect(mockIframe.srcdoc).toContain('0.75in');
  });

  it('sets the title element from the print-title attribute', () => {
    el.setAttribute('print-title', 'My Report');
    el.print();
    expect(mockIframe.srcdoc).toContain('<title>My Report</title>');
  });

  it('injects a body reset to suppress browser default margins', () => {
    el.print();
    expect(mockIframe.srcdoc).toContain('margin:0');
    expect(mockIframe.srcdoc).toContain('background:white');
  });

  it('keeps the default label when children are whitespace only', () => {
    const ws = document.createElement('print-element-button');
    ws.setAttribute('target', '#asm-target');
    ws.appendChild(document.createTextNode('   '));
    document.body.appendChild(ws);
    expect(ws.querySelector('button').textContent.trim()).toBe('🖨️ Print');
    ws.remove();
  });

  it('rewrites lazy images to eager inside the target', () => {
    target.innerHTML = '<img src="photo.jpg" loading="lazy">';
    el.print();
    expect(mockIframe.srcdoc).not.toContain('loading="lazy"');
    expect(mockIframe.srcdoc).toContain('loading="eager"');
  });

  it('inlines document-level adopted stylesheets', () => {
    const mockSheet = { cssRules: [{ cssText: '.adopted { color: teal; }' }] };
    const orig = Object.getOwnPropertyDescriptor(Document.prototype, 'adoptedStyleSheets');
    Object.defineProperty(document, 'adoptedStyleSheets', {
      get: () => [mockSheet],
      configurable: true,
    });

    el.print();
    const { srcdoc } = mockIframe;

    if (orig) {
      Object.defineProperty(document, 'adoptedStyleSheets', orig);
    } else {
      delete document.adoptedStyleSheets;
    }

    expect(srcdoc).toContain('.adopted { color: teal; }');
  });
});

// ── Print flow ────────────────────────────────────────────────────────────────

describe('PrintElementButton — print flow', () => {
  let el;
  let target;

  beforeEach(() => {
    target = document.createElement('div');
    target.id = 'print-target';
    target.innerHTML = '<p>Content</p>';
    document.body.appendChild(target);

    el = document.createElement('print-element-button');
    el.setAttribute('target', '#print-target');
    document.body.appendChild(el);

    installIframeSpy();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    el.remove();
    target.remove();
    mockIframe = null;
  });

  it('disables the button synchronously when print() is called', () => {
    const btn = el.querySelector('button');
    el.print().catch(() => {});
    expect(btn.disabled).toBe(true);
  });

  it('re-enables the button after afterprint fires', async () => {
    const btn = el.querySelector('button');
    const promise = el.print();
    await tick();
    fireLoad();
    await tick();
    fireAfterprint();
    await promise;
    expect(btn.disabled).toBe(false);
  });

  it('dispatches print-start once the iframe is ready', async () => {
    const events = [];
    el.addEventListener('print-start', () => events.push('print-start'));

    el.print();
    await tick();
    fireLoad();
    await tick();

    expect(events).toContain('print-start');
  });

  it('dispatches print-end after afterprint fires', async () => {
    const events = [];
    el.addEventListener('print-start', () => events.push('print-start'));
    el.addEventListener('print-end', () => events.push('print-end'));

    const promise = el.print();
    await tick();
    fireLoad();
    await tick();
    fireAfterprint();
    await promise;

    expect(events).toEqual(['print-start', 'print-end']);
  });

  it('print-end detail is undefined on a normal close', async () => {
    let detail;
    el.addEventListener('print-end', e => { detail = e.detail; });

    const promise = el.print();
    await tick();
    fireLoad();
    await tick();
    fireAfterprint();
    await promise;

    expect(detail).toBeNull();
  });

  it('calls focus() and print() on the iframe contentWindow', async () => {
    const promise = el.print();
    await tick();
    fireLoad();
    await tick();

    expect(mockWindow.focus).toHaveBeenCalledOnce();
    expect(mockWindow.print).toHaveBeenCalledOnce();

    fireAfterprint();
    await promise;
  });

  it('removes the iframe after the print dialog closes', async () => {
    const promise = el.print();
    await tick();
    fireLoad();
    await tick();

    expect(document.body.contains(mockIframe)).toBe(true);

    fireAfterprint();
    await promise;

    expect(document.body.contains(mockIframe)).toBe(false);
  });

  it('clicking the button triggers print()', () => {
    const spy = vi.spyOn(el, 'print').mockResolvedValue(undefined);
    el.querySelector('button').click();
    expect(spy).toHaveBeenCalledOnce();
  });

  it('in-flight guard: second print() rejects with InvalidStateError', async () => {
    const p1 = el.print();
    const p2 = el.print();

    await expect(p2).rejects.toMatchObject({ name: 'InvalidStateError' });

    await tick();
    fireLoad();
    await tick();
    fireAfterprint();
    await p1;
  });

  it('cancel() before load fires does not dispatch print-start or print-end', async () => {
    const events = [];
    el.addEventListener('print-start', () => events.push('print-start'));
    el.addEventListener('print-end', () => events.push('print-end'));

    const promise = el.print();
    el.cancel();
    await tick();
    await promise;

    expect(events).toHaveLength(0);
  });

  it('cancel() after print-start still fires print-end', async () => {
    const events = [];
    el.addEventListener('print-start', () => events.push('print-start'));
    el.addEventListener('print-end', () => events.push('print-end'));

    const promise = el.print();
    await tick();
    fireLoad();
    await tick();
    // print-start has fired; we are now in the afterprint wait

    el.cancel();
    await tick();
    await promise;

    expect(events).toEqual(['print-start', 'print-end']);
  });

  it('cancel() re-enables the button', async () => {
    const btn = el.querySelector('button');
    const promise = el.print();
    expect(btn.disabled).toBe(true);

    el.cancel();
    await promise;
    expect(btn.disabled).toBe(false);
  });

  it('disconnectedCallback cancels an in-flight print', async () => {
    const promise = el.print();
    el.remove(); // triggers disconnectedCallback → cancel()
    await tick();
    await promise; // resolves cleanly, no throw
  });

  it('dispatches print-error when the target selector matches nothing', async () => {
    el.setAttribute('target', '#does-not-exist');
    const errors = [];
    el.addEventListener('print-error', e => errors.push(e.detail.error));

    await expect(el.print()).rejects.toThrow('Target element not found');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/target/i);
  });

  it('dispatches print-error when iframeWin.print() throws', async () => {
    const printErr = new Error('Blocked by browser');
    const errors = [];
    el.addEventListener('print-error', e => errors.push(e.detail.error));

    const promise = el.print();
    promise.catch(() => {}); // suppress unhandled-rejection warning; we assert below
    // mockWindow is set synchronously during el.print(); override before it fires
    mockWindow.print.mockImplementation(() => { throw printErr; });

    fireLoad();
    await tick();

    await expect(promise).rejects.toBe(printErr);
    expect(errors[0]).toBe(printErr);
  });

  it('falls back to parentElement when no target attribute is set', async () => {
    el.removeAttribute('target');
    const promise = el.print();
    await tick();
    fireLoad();
    await tick();
    fireAfterprint();
    await promise;
  });

  it('fires print-end with { timedOut: true } after 60 seconds with no afterprint', async () => {
    vi.useFakeTimers();
    try {
      const events = [];
      el.addEventListener('print-end', e => events.push(e));

      el.print();
      // fire load and flush the microtask chain (fonts.ready race + img.decode + print-start)
      mockIframe.dispatchEvent(new Event('load'));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve(); // extra tick: Promise.race adds one hop vs a bare await

      vi.advanceTimersByTime(60_000);
      // timeout callback dispatches print-end synchronously

      expect(events).toHaveLength(1);
      expect(events[0].detail).toEqual({ timedOut: true });
    } finally {
      vi.useRealTimers();
    }
  });
});
