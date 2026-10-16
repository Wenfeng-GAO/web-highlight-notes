// Issue #18: an SVG highlight measured before the diagram is rendered stays 「未定位」
// until reload. Retry when a details toggle, a resize, or an intersection shows it,
// and once more when late web fonts finish loading. No polling.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { armSvgRelayout, watchSvgReveal } from '../../src/lib/svg-reveal.js';

let observers;

class ResizeObserverStub {
  constructor(callback) {
    this.callback = callback;
    this.elements = [];
    observers.resize.push(this);
  }

  observe(element) {
    this.elements.push(element);
  }

  disconnect() {
    this.dead = true;
  }

  emit(element, width, height) {
    this.callback([{ target: element, contentRect: { width, height } }]);
  }
}

class IntersectionObserverStub {
  constructor(callback) {
    this.callback = callback;
    observers.intersection.push(this);
  }

  observe() {}

  disconnect() {
    this.dead = true;
  }

  emit(element, width, height, isIntersecting) {
    this.callback([{
      target: element,
      isIntersecting,
      boundingClientRect: { width, height },
    }]);
  }
}

beforeEach(() => {
  observers = { resize: [], intersection: [] };
  globalThis.ResizeObserver = ResizeObserverStub;
  globalThis.IntersectionObserver = IntersectionObserverStub;
  globalThis.requestAnimationFrame = (callback) => {
    callback();
    return 1;
  };
  globalThis.cancelAnimationFrame = () => {};
  document.body.innerHTML = '<svg id="d"><text id="t">隐藏标签</text></svg>';
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('watchSvgReveal', () => {
  it('retries when a hidden svg gains a box, and ignores later resizes', () => {
    const svg = document.getElementById('d');
    const onReveal = vi.fn();
    const watch = watchSvgReveal([svg], onReveal);
    expect(onReveal).not.toHaveBeenCalled();
    observers.resize[0].emit(svg, 0, 0);
    expect(onReveal).not.toHaveBeenCalled();
    observers.resize[0].emit(svg, 120, 40);
    expect(onReveal).toHaveBeenCalledTimes(1);
    observers.resize[0].emit(svg, 130, 40);
    expect(onReveal).toHaveBeenCalledTimes(1);
    watch.disconnect();
    observers.resize[0].emit(svg, 0, 0);
    observers.resize[0].emit(svg, 120, 40);
    expect(onReveal).toHaveBeenCalledTimes(1);
  });

  it('does not retry an svg that already has a box', () => {
    const svg = document.getElementById('d');
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({ width: 100, height: 40, x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 40 });
    const onReveal = vi.fn();
    watchSvgReveal([svg], onReveal);
    observers.resize[0].emit(svg, 100, 40);
    expect(onReveal).not.toHaveBeenCalled();
  });

  it('retries when a closed details element opens around the svg', () => {
    const svg = document.getElementById('d');
    const details = document.createElement('details');
    details.append(svg);
    document.body.append(details);
    const onReveal = vi.fn();
    watchSvgReveal([svg], onReveal);
    details.dispatchEvent(new Event('toggle'));
    expect(onReveal).not.toHaveBeenCalled();
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
    expect(onReveal).toHaveBeenCalledTimes(1);
  });

  it('retries when the svg scrolls into view from a zero box', () => {
    const svg = document.getElementById('d');
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({ width: 0, height: 0, x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0 });
    const onReveal = vi.fn();
    watchSvgReveal([svg], onReveal);
    observers.intersection[0].emit(svg, 0, 0, false);
    expect(onReveal).not.toHaveBeenCalled();
    observers.intersection[0].emit(svg, 80, 30, true);
    expect(onReveal).toHaveBeenCalledTimes(1);
  });
});

describe('armSvgRelayout', () => {
  it('remeasures once when document.fonts.ready resolves, and does not poll', () => {
    vi.spyOn(globalThis, 'setInterval');
    let resolveReady;
    const fonts = {
      status: 'loading',
      ready: new Promise((resolve) => {
        resolveReady = resolve;
      }),
    };
    const onRetry = vi.fn();
    const slot = { reveal: null, fontArmed: false };
    const svg = document.getElementById('d');
    armSvgRelayout({
      hosts: [],
      fonts,
      hasSvgMarks: true,
      onRetry,
      slot,
      watch: () => ({ disconnect() {} }),
    });
    expect(onRetry).not.toHaveBeenCalled();
    expect(setInterval).not.toHaveBeenCalled();
    fonts.status = 'loaded';
    resolveReady();
    return fonts.ready.then(() => {
      expect(onRetry).toHaveBeenCalledTimes(1);
      armSvgRelayout({
        hosts: [],
        fonts,
        hasSvgMarks: true,
        onRetry,
        slot,
        watch: () => ({ disconnect() {} }),
      });
      expect(onRetry).toHaveBeenCalledTimes(1);
    });
  });

  it('watches only the svgs that are still unmeasured', () => {
    const seen = [];
    const slot = { reveal: null, fontArmed: false };
    const svg = document.getElementById('d');
    armSvgRelayout({
      hosts: [svg],
      fonts: { status: 'loaded', ready: Promise.resolve() },
      hasSvgMarks: false,
      onRetry: () => {},
      slot,
      watch: (elements) => {
        seen.push(...elements);
        return { disconnect() { seen.push('off'); } };
      },
    });
    expect(seen).toEqual([svg]);
    armSvgRelayout({
      hosts: [],
      fonts: { status: 'loaded', ready: Promise.resolve() },
      hasSvgMarks: false,
      onRetry: () => {},
      slot,
      watch: () => {
        throw new Error('nothing left to watch');
      },
    });
    expect(seen).toEqual([svg, 'off']);
  });
});
