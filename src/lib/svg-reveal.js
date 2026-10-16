/**
 * Call onReveal when an SVG that had no box becomes measurable.
 * Listens for <details> toggle, ResizeObserver, and IntersectionObserver.
 * Does not poll. An already-positive size is not a signal: that is the layout
 * just measured (or refused) by the caller.
 */
export function watchSvgReveal(elements, onReveal) {
  const hosts = [...new Set(elements)].filter((element) => element);
  if (!hosts.length || typeof onReveal !== 'function') return { disconnect() {} };

  const area = new WeakMap();
  let frame = 0;
  let dead = false;
  let arming = false;
  const schedule = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (callback) => setTimeout(callback, 0);
  const cancel = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : clearTimeout;
  const doc = hosts[0].ownerDocument || document;

  const fire = () => {
    if (dead || frame) return;
    frame = schedule(() => {
      frame = 0;
      if (!dead) onReveal();
    });
  };

  const boxArea = (element) => {
    const box = element.getBoundingClientRect?.();
    if (!box) return 0;
    return Math.max(0, box.width) * Math.max(0, box.height);
  };
  for (const element of hosts) area.set(element, boxArea(element));

  let resize = null;
  if (typeof ResizeObserver === 'function') {
    resize = new ResizeObserver((entries) => {
      if (arming) return;
      let shown = false;
      for (const entry of entries) {
        const next = Math.max(0, entry.contentRect.width) * Math.max(0, entry.contentRect.height);
        const prev = area.get(entry.target) || 0;
        area.set(entry.target, next);
        if (next > 0 && prev === 0) shown = true;
      }
      if (shown) fire();
    });
    arming = true;
    for (const element of hosts) resize.observe(element);
    arming = false;
  }

  let intersection = null;
  if (typeof IntersectionObserver === 'function') {
    intersection = new IntersectionObserver((entries) => {
      if (arming) return;
      let shown = false;
      for (const entry of entries) {
        const box = entry.boundingClientRect;
        const next = Math.max(0, box.width) * Math.max(0, box.height);
        const prev = area.get(entry.target) || 0;
        if (next > 0) area.set(entry.target, next);
        if (entry.isIntersecting && next > 0 && prev === 0) shown = true;
      }
      if (shown) fire();
    });
    arming = true;
    for (const element of hosts) intersection.observe(element);
    arming = false;
  }

  const onToggle = (event) => {
    const details = event.target;
    if (!details || details.localName !== 'details' || !details.open) return;
    if (hosts.some((element) => details.contains(element))) fire();
  };
  doc.addEventListener('toggle', onToggle, true);

  return {
    disconnect() {
      dead = true;
      if (frame) cancel(frame);
      frame = 0;
      resize?.disconnect();
      intersection?.disconnect();
      doc.removeEventListener('toggle', onToggle, true);
    },
  };
}

/**
 * Watch svgs that still have no glyph box, and remeasure once when web fonts finish.
 * `slot` is { reveal, fontArmed } owned by the caller so repeated renders don't stack listeners.
 */
export function armSvgRelayout({ hosts, fonts, hasSvgMarks, onRetry, slot, watch = watchSvgReveal }) {
  slot.reveal?.disconnect();
  slot.reveal = null;
  const pending = hosts || [];
  if (pending.length) slot.reveal = watch(pending, onRetry);
  const fontPending = !!(fonts && fonts.status && fonts.status !== 'loaded' && typeof fonts.ready?.then === 'function' && (pending.length || hasSvgMarks));
  if (!fontPending || slot.fontArmed) return;
  slot.fontArmed = true;
  fonts.ready.then(() => {
    slot.fontArmed = false;
    if (fonts.status === 'loaded') onRetry();
  }, () => {
    slot.fontArmed = false;
  });
}
