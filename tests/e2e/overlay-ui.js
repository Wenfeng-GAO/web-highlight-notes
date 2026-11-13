// Drive the in-page overlay through CDP. Closed shadow roots are invisible to
// page scripts and to Playwright's selectors; the DOM agent can still see them.
// Clicks are real mouse input, so they stay trusted events.
import { expect } from '@playwright/test';

const sessions = new WeakMap();

async function cdp(page) {
  let client = sessions.get(page);
  if (!client) {
    client = await page.context().newCDPSession(page);
    sessions.set(page, client);
  }
  return client;
}

function walk(node, visit) {
  if (!node) return;
  visit(node);
  for (const child of node.children || []) walk(child, visit);
  for (const shadow of node.shadowRoots || []) walk(shadow, visit);
  if (node.contentDocument) walk(node.contentDocument, visit);
}

function shadowRootNode(root) {
  let found = null;
  walk(root, (node) => {
    const attrs = node.attributes || [];
    for (let i = 0; i < attrs.length; i += 2) {
      if (attrs[i] === 'id' && attrs[i + 1] === 'whn-root' && node.shadowRoots?.[0]) found = node.shadowRoots[0];
    }
  });
  return found;
}

async function describe(client, backendNodeId) {
  const { object } = await client.send('DOM.resolveNode', { backendNodeId });
  try {
    const { result } = await client.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      returnByValue: true,
      functionDeclaration: `function() {
        const rect = this.getBoundingClientRect();
        const style = getComputedStyle(this);
        const shown = style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        return {
          tag: this.localName,
          role: this.getAttribute('role'),
          aria: this.getAttribute('aria-label'),
          text: (this.textContent || '').trim(),
          placeholder: this.getAttribute('placeholder'),
          value: 'value' in this ? this.value : null,
          shown,
          top: rect.top,
          left: rect.left,
          width: rect.width,
          height: rect.height,
        };
      }`,
    });
    return result.value;
  } finally {
    await client.send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {});
  }
}

async function nodes(page) {
  const client = await cdp(page);
  const { root } = await client.send('DOM.getDocument', { depth: -1, pierce: true });
  const shadow = shadowRootNode(root);
  if (!shadow) return [];
  const targets = [];
  walk(shadow, (node) => {
    const tag = (node.localName || node.nodeName || '').toLowerCase();
    if (tag === 'button' || tag === 'textarea' || tag === 'iframe' || (node.attributes || []).includes('role')) {
      if (node.backendNodeId) targets.push(node.backendNodeId);
    }
  });
  const found = [];
  for (const backendNodeId of targets) found.push(await describe(client, backendNodeId));
  return found;
}

function roleOf(info) {
  if (info.role) return info.role;
  if (info.tag === 'button') return 'button';
  if (info.tag === 'textarea') return 'textbox';
  return info.tag;
}

function matches(info, spec) {
  if (spec.role && roleOf(info) !== spec.role) return false;
  if (spec.placeholder && info.placeholder !== spec.placeholder) return false;
  if (!spec.name) return true;
  const candidates = [info.aria, info.text].filter((value) => value);
  return candidates.some((value) => (spec.exact === false ? value.includes(spec.name) : value === spec.name));
}

async function find(page, spec) {
  const found = (await nodes(page)).filter((info) => matches(info, spec));
  return found.find((info) => info.shown) || found[0] || null;
}

async function clickAt(page, info) {
  if (!info?.shown) throw new Error(`overlay control not visible (${info?.role || info?.tag || 'missing'} ${info?.text || info?.aria || ''})`);
  await page.mouse.click(info.left + info.width / 2, info.top + info.height / 2);
}

async function waitShown(page, spec) {
  let info = null;
  await expect.poll(async () => {
    info = await find(page, spec);
    return !!info?.shown;
  }, { timeout: 15000 }).toBe(true);
  return info;
}

export function overlayControl(page, spec) {
  return {
    spec,
    isVisible: async () => !!(await find(page, spec))?.shown,
    inputValue: async () => (await find(page, spec))?.value ?? null,
    textContent: async () => (await find(page, spec))?.text ?? null,
    box: async () => {
      const info = await find(page, spec);
      if (!info) return null;
      return {
        top: info.top,
        bottom: info.top + info.height,
        left: info.left,
        right: info.left + info.width,
        width: info.width,
        height: info.height,
      };
    },
    click: async () => clickAt(page, await waitShown(page, spec)),
    fill: async (text) => {
      await clickAt(page, await waitShown(page, spec));
      await page.keyboard.press('Control+A');
      await page.keyboard.insertText(String(text));
    },
    press: async (key) => {
      await clickAt(page, await waitShown(page, spec));
      await page.keyboard.press(key);
    },
    pressSequentially: async (text) => {
      await clickAt(page, await waitShown(page, spec));
      await page.keyboard.type(String(text));
    },
    getByRole(role, options = {}) {
      return overlayControl(page, { role, name: options.name, exact: options.exact !== false });
    },
    getByPlaceholder(text) {
      return overlayControl(page, { placeholder: text });
    },
  };
}

export function overlayButton(page, name) {
  return overlayControl(page, { role: 'button', name, exact: true });
}

export function overlayDialog(page, name) {
  return overlayControl(page, { role: 'dialog', name, exact: true });
}

export function overlayToolbar(page, name) {
  return overlayControl(page, { role: 'toolbar', name, exact: true });
}

export function expectOverlay(control, message) {
  const options = { timeout: 15000, message };
  return {
    async toBeVisible() {
      await expect.poll(() => control.isVisible(), options).toBe(true);
    },
    async toBeHidden() {
      await expect.poll(() => control.isVisible(), options).toBe(false);
    },
    async toHaveValue(value) {
      await expect.poll(() => control.inputValue(), options).toBe(value);
    },
  };
}

export async function readyPrompt(page) {
  let frame = null;
  await expect.poll(() => {
    frame = promptFrame(page);
    return frame ? frame.url() : '';
  }).toContain('/src/prompt/prompt.html');
  await expect.poll(() => frame.evaluate(() => document.documentElement.dataset.ready || '')).toBe('1');
  return frame;
}

export async function overlayBox(page, selector) {
  const client = await cdp(page);
  const { root } = await client.send('DOM.getDocument', { depth: -1, pierce: true });
  const shadow = shadowRootNode(root);
  if (!shadow?.backendNodeId) return null;
  const wanted = selector.replace(/^\./, '');
  let match = null;
  walk(shadow, (node) => {
    const attrs = node.attributes || [];
    const className = (() => {
      for (let i = 0; i < attrs.length; i += 2) if (attrs[i] === 'class') return attrs[i + 1];
      return '';
    })();
    const tag = (node.localName || '').toLowerCase();
    if (selector.startsWith('.') && className.split(/\s+/).includes(wanted)) match = node;
    else if (selector.includes('.')) {
      const [tagName, classPart] = selector.split('.');
      if (tag === tagName && className.split(/\s+/).includes(classPart)) match = node;
    } else if (tag === selector) match = node;
  });
  if (!match?.backendNodeId) return null;
  const info = await describe(client, match.backendNodeId);
  return {
    top: info.top,
    bottom: info.top + info.height,
    left: info.left,
    right: info.left + info.width,
    width: info.width,
    height: info.height,
    shown: info.shown,
  };
}

async function evalIn(client, backendNodeId, source) {
  const { object } = await client.send('DOM.resolveNode', { backendNodeId });
  try {
    const { result } = await client.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      returnByValue: true,
      functionDeclaration: source,
    });
    return result.value;
  } finally {
    await client.send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {});
  }
}

function classNameOf(node) {
  const attrs = node.attributes || [];
  for (let i = 0; i < attrs.length; i += 2) if (attrs[i] === 'class') return attrs[i + 1];
  return '';
}

function findShadowChild(shadow, tagName, classToken) {
  let match = null;
  walk(shadow, (node) => {
    const tag = (node.localName || '').toLowerCase();
    if (tag === tagName && classNameOf(node).split(/\s+/).includes(classToken)) match = node;
  });
  return match;
}

/** Real bubble state inside the closed root. Page script cannot see this. */
export async function overlayBubbleState(page) {
  const client = await cdp(page);
  const { root } = await client.send('DOM.getDocument', { depth: -1, pierce: true });
  const shadow = shadowRootNode(root);
  const empty = { present: false, open: false, shown: false, display: null, visibility: null, value: null };
  if (!shadow) return empty;
  const bubble = findShadowChild(shadow, 'div', 'bubble');
  if (!bubble?.backendNodeId) return empty;
  return evalIn(client, bubble.backendNodeId, `function() {
    const style = getComputedStyle(this);
    const area = this.querySelector('textarea');
    const rect = this.getBoundingClientRect();
    return {
      present: true,
      open: this.classList.contains('open'),
      shown: style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0,
      display: style.display,
      visibility: style.visibility,
      value: area ? area.value : null,
    };
  }`);
}

export function promptFrame(page) {
  return page.frames().find((frame) => frame.url().includes('/src/prompt/prompt.html')) || null;
}

export async function promptShown(page) {
  const box = await overlayBox(page, 'iframe.prompt');
  return !!box?.shown;
}
