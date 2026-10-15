import { localize } from '../lib/i18n.js';

// Runs as an extension page inside the in-page card, so the 「允许」 click is a
// user gesture in an extension context and may call chrome.permissions.request.
const DECLINED_KEY = '__whn:declined';
const pattern = new URLSearchParams(location.search).get('origin') || '';

localize(document);

function post(message) {
  window.parent.postMessage({ whnPrompt: true, ...message }, '*');
}

async function decline() {
  if (!pattern) return;
  const stored = await chrome.storage.local.get(DECLINED_KEY);
  await chrome.storage.local.set({ [DECLINED_KEY]: { ...(stored[DECLINED_KEY] || {}), [pattern]: Date.now() } });
}

document.querySelector('.allow').addEventListener('click', async () => {
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: [pattern] });
  } catch {
    granted = false;
  }
  if (!granted) await decline();
  post({ type: 'done', granted });
});

document.querySelector('.later').addEventListener('click', async () => {
  await decline();
  post({ type: 'done', granted: false });
});

function reportSize() {
  post({ type: 'size', height: Math.ceil(document.querySelector('.card').getBoundingClientRect().height) });
}
new ResizeObserver(reportSize).observe(document.querySelector('.card'));
reportSize();
