import { isPromptHost } from '../lib/prompt-host.js';
import { localize } from '../lib/i18n.js';

// The card is an extension page. The host it may grant or decline is looked up
// from a per-tab token the worker issued to the content script. The query
// string is not a source of the host: a page that embeds this file, or rewrites
// the query, cannot choose an origin.
const ctx = new URLSearchParams(location.search).get('ctx') || '';
let pattern = '';

localize(document);

function parentOrigin() {
  const origin = location.ancestorOrigins?.[0] || '';
  return origin.startsWith('http:') || origin.startsWith('https:') || origin.startsWith('file:') ? origin : '*';
}

function post(message) {
  window.parent.postMessage({ whnPrompt: true, ...message }, parentOrigin());
}

try {
  const bound = await chrome.runtime.sendMessage({ type: 'whn:prompt-bind', ctx });
  if (bound?.ok && isPromptHost(bound.pattern)) pattern = bound.pattern;
} catch {
  pattern = '';
}

document.querySelector('.allow').addEventListener('click', async () => {
  if (!pattern) return;
  // permissions.request has to be the first await in this gesture.
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: [pattern] });
  } catch {
    granted = false;
  }
  try {
    await chrome.runtime.sendMessage({ type: granted ? 'whn:prompt-finish' : 'whn:prompt-decline', ctx });
  } catch {
    // The page still needs to hear that the card is done.
  }
  post({ type: 'done', granted });
});

document.querySelector('.later').addEventListener('click', async () => {
  if (!pattern) return;
  try {
    await chrome.runtime.sendMessage({ type: 'whn:prompt-decline', ctx });
  } catch {
    // Closing the card matters more than a retry here.
  }
  post({ type: 'done', granted: false });
});

if (pattern) document.documentElement.dataset.ready = '1';

function reportSize() {
  post({ type: 'size', height: Math.ceil(document.querySelector('.card').getBoundingClientRect().height) });
}
new ResizeObserver(reportSize).observe(document.querySelector('.card'));
reportSize();
