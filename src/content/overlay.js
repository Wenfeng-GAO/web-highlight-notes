import { t } from '../lib/i18n.js';

const FONT = 'system-ui, -apple-system, "PingFang SC", sans-serif';

const CSS = `
  :host {
    font-family: ${FONT};
    color: #1F2328;
  }
  .toolbar,
  .bubble {
    position: absolute;
    display: none;
    visibility: hidden;
    pointer-events: auto;
    font-family: ${FONT};
  }
  .toolbar.open,
  .bubble.open {
    visibility: visible;
  }
  .toolbar.open {
    display: inline-flex;
  }
  .bubble.open {
    display: block;
  }
  .toolbar {
    height: 32px;
    box-sizing: border-box;
    align-items: center;
    gap: 4px;
    padding: 0 4px;
    background: #1F2328;
    color: #ffffff;
    border-radius: 999px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
    user-select: none;
    white-space: nowrap;
  }
  .toolbar button {
    height: 24px;
    border: 0;
    background: transparent;
    color: #ffffff;
    font-family: ${FONT};
    font-size: 12px;
    line-height: 24px;
    padding: 0 8px;
    border-radius: 999px;
    cursor: pointer;
  }
  .toolbar button:hover {
    background: rgba(255, 255, 255, 0.12);
  }
  .bubble {
    width: 280px;
    box-sizing: border-box;
    padding: 12px;
    background: #ffffff;
    color: #1F2328;
    border: 1px solid #E5E7EB;
    border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
  }
  .bubble .quote {
    margin: 0 0 8px;
    font-size: 12px;
    line-height: 1.4;
    color: #6B7280;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .bubble textarea {
    display: block;
    width: 100%;
    min-height: 64px;
    box-sizing: border-box;
    margin: 0;
    padding: 8px;
    border: 1px solid #E5E7EB;
    border-radius: 8px;
    background: #ffffff;
    color: #1F2328;
    font-family: ${FONT};
    font-size: 13px;
    line-height: 1.5;
    resize: vertical;
  }
  .bubble textarea:focus {
    outline: 2px solid #1F2328;
    outline-offset: 1px;
  }
  .actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-top: 8px;
  }
  .danger,
  .primary {
    font-family: ${FONT};
    cursor: pointer;
  }
  .danger {
    border: 0;
    background: transparent;
    color: #DC2626;
    font-size: 12px;
    line-height: 1.4;
    padding: 4px 0;
  }
  .prompt {
    position: absolute;
    display: none;
    width: 240px;
    height: 64px;
    box-sizing: border-box;
    border: 1px solid #E5E7EB;
    border-radius: 8px;
    background: #ffffff;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
    pointer-events: auto;
    overflow: hidden;
  }
  .prompt.open {
    display: block;
  }
  .primary {
    height: 32px;
    border: 0;
    border-radius: 8px;
    background: #1F2328;
    color: #ffffff;
    font-size: 13px;
    padding: 0 12px;
  }
`;

export function mountOverlay() {
  const host = document.createElement('div');
  host.id = 'whn-root';
  host.style.cssText = [
    'display: block',
    'position: fixed',
    'inset: 0',
    'z-index: 2147483647',
    'pointer-events: none',
    'background: transparent',
    'margin: 0',
    'padding: 0',
    'border: 0',
  ].join(';');
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>${CSS}</style>
    <div class="toolbar" role="toolbar">
      <button type="button" data-action="highlight"></button>
      <button type="button" data-action="highlight-comment"></button>
    </div>
    <div class="bubble" role="dialog">
      <div class="quote"></div>
      <textarea></textarea>
      <div class="actions">
        <button type="button" class="danger" data-action="delete"></button>
        <button type="button" class="primary" data-action="save"></button>
      </div>
    </div>
    <iframe class="prompt" title=""></iframe>
  `;
  // Strings are set as text/attributes, never parsed as HTML.
  shadow.querySelector('.toolbar').setAttribute('aria-label', t('toolbarLabel'));
  shadow.querySelector('[data-action="highlight"]').textContent = t('toolbarHighlight');
  shadow.querySelector('[data-action="highlight-comment"]').textContent = t('toolbarHighlightComment');
  shadow.querySelector('.bubble').setAttribute('aria-label', t('bubbleLabel'));
  shadow.querySelector('textarea').setAttribute('aria-label', t('bubbleCommentLabel'));
  shadow.querySelector('textarea').setAttribute('placeholder', t('bubbleCommentPlaceholder'));
  shadow.querySelector('[data-action="delete"]').textContent = t('bubbleDelete');
  shadow.querySelector('[data-action="save"]').textContent = t('bubbleSave');
  shadow.querySelector('.prompt').title = t('promptLabel');

  const toolbar = shadow.querySelector('.toolbar');
  const bubble = shadow.querySelector('.bubble');
  const quoteEl = shadow.querySelector('.quote');
  const textarea = shadow.querySelector('textarea');
  const prompt = shadow.querySelector('.prompt');

  function place(element, top, left) {
    element.style.top = `${Math.round(top)}px`;
    element.style.left = `${Math.round(left)}px`;
    element.style.visibility = 'visible';
  }

  return {
    host,
    shadow,
    toolbar,
    bubble,
    quoteEl,
    textarea,
    highlightBtn: shadow.querySelector('[data-action="highlight"]'),
    commentBtn: shadow.querySelector('[data-action="highlight-comment"]'),
    saveBtn: shadow.querySelector('[data-action="save"]'),
    deleteBtn: shadow.querySelector('[data-action="delete"]'),
    toolbarOpen() {
      return toolbar.classList.contains('open');
    },
    bubbleOpen() {
      return bubble.classList.contains('open');
    },
    showToolbar() {
      toolbar.classList.add('open');
    },
    hideToolbar() {
      toolbar.classList.remove('open');
      toolbar.style.visibility = 'hidden';
    },
    showBubble() {
      bubble.classList.add('open');
    },
    hideBubble() {
      bubble.classList.remove('open');
      bubble.style.visibility = 'hidden';
    },
    placeToolbar(rect) {
      this.showToolbar();
      toolbar.style.visibility = 'hidden';
      const width = toolbar.offsetWidth || 148;
      const height = toolbar.offsetHeight || 32;
      let top = rect.top - 8 - height;
      if (top < 4) top = rect.bottom + 8;
      let left = rect.left + rect.width / 2 - width / 2;
      left = Math.max(4, Math.min(left, window.innerWidth - width - 4));
      place(toolbar, top, left);
      return { top: rect.top };
    },
    placeBubble(rect) {
      this.showBubble();
      bubble.style.visibility = 'hidden';
      const width = bubble.offsetWidth || 280;
      const height = bubble.offsetHeight || 160;
      let top = rect.bottom + 6;
      if (top + height > window.innerHeight - 8) top = Math.max(4, rect.top - 6 - height);
      let left = rect.left;
      left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
      place(bubble, top, left);
    },
    prompt,
    promptOpen() {
      return prompt.classList.contains('open');
    },
    /**
     * Card 8px below the selection (and below the toolbar or bubble if they sit
     * under it), flipped above everything when the viewport has no room below.
     * `anchor` is the highlight's rect; `obstacles` are other rects to keep clear of.
     */
    placePrompt(anchor, obstacles = []) {
      if (!anchor) return;
      const width = 240;
      const height = prompt.offsetHeight || parseFloat(prompt.style.height) || 64;
      const near = obstacles.filter((rect) => rect && rect.width && rect.height
        && rect.left < anchor.right + width && rect.right > anchor.left - width);
      const below = near.filter((rect) => rect.top >= anchor.top);
      const above = near.filter((rect) => rect.top < anchor.top);
      let top = Math.max(anchor.bottom, ...below.map((rect) => rect.bottom)) + 8;
      if (top + height > window.innerHeight - 4) {
        const ceiling = Math.min(anchor.top, ...above.map((rect) => rect.top), ...below.map((rect) => rect.top));
        top = Math.max(4, ceiling - 8 - height);
      }
      const left = Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8));
      prompt.style.top = `${Math.round(top)}px`;
      prompt.style.left = `${Math.round(left)}px`;
    },
    showPrompt(src, anchor, obstacles) {
      if (prompt.getAttribute('src') !== src) prompt.setAttribute('src', src);
      prompt.classList.add('open');
      this.placePrompt(anchor, obstacles);
    },
    setPromptHeight(height) {
      if (height > 0 && height < 400) prompt.style.height = `${height + 2}px`;
    },
    hidePrompt() {
      prompt.classList.remove('open');
      prompt.removeAttribute('src');
    },
    eventFromHost(event) {
      return event.target === host || host.contains(event.target);
    },
  };
}
