// Download watchers are separate from clipboard.writeText. Replacing writeText
// must not remove them. __whnCopied is the argument passed to a wrapper, not
// the result of navigator.clipboard.readText.
import { expect } from '@playwright/test';

export async function armDownloadWatch(panel) {
  const downloads = [];
  panel.on('download', (download) => {
    downloads.push(download.suggestedFilename());
    download.cancel().catch(() => {});
  });
  await panel.evaluate(() => {
    if (window.__whnDownloadWatch) return;
    window.__whnDownloadWatch = true;
    window.__whnAnchorClicks = [];
    window.__whnObjectUrls = 0;
    const origClick = HTMLAnchorElement.prototype.click;
    function spyClick() {
      window.__whnAnchorClicks.push({ download: this.download || '', href: String(this.href || '') });
      return origClick.apply(this, arguments);
    }
    spyClick.__whnDownloadSpy = true;
    HTMLAnchorElement.prototype.click = spyClick;
    const origCreate = URL.createObjectURL.bind(URL);
    function spyCreate(...args) {
      window.__whnObjectUrls += 1;
      return origCreate(...args);
    }
    spyCreate.__whnDownloadSpy = true;
    URL.createObjectURL = spyCreate;
  });
  return downloads;
}

export async function assertDownloadWatchLive(panel) {
  const live = await panel.evaluate(() => ({
    anchor: HTMLAnchorElement.prototype.click.__whnDownloadSpy === true,
    createObjectURL: URL.createObjectURL.__whnDownloadSpy === true,
  }));
  expect(live).toEqual({ anchor: true, createObjectURL: true });
}

export async function armCopyWatch(panel) {
  const downloads = await armDownloadWatch(panel);
  await panel.evaluate(() => {
    if (window.__whnCopyWatch) return;
    window.__whnCopyWatch = true;
    window.__whnCopied = '';
    const clipboard = navigator.clipboard;
    const original = typeof clipboard.writeText === 'function' ? clipboard.writeText.bind(clipboard) : null;
    clipboard.writeText = async (text) => {
      window.__whnCopied = String(text);
      if (!original) throw new Error('clipboard.writeText is missing');
      return original(text);
    };
  });
  return downloads;
}

export async function assertNoDownload(panel, downloads) {
  await panel.waitForTimeout(400);
  expect(downloads).toEqual([]);
  const extra = await panel.evaluate(() => ({
    anchors: (window.__whnAnchorClicks || []).filter((item) => item.download),
    urls: window.__whnObjectUrls || 0,
  }));
  expect(extra.anchors).toEqual([]);
  expect(extra.urls).toBe(0);
}

export async function readCopiedMarkdown(panel, { button, copied }) {
  const downloads = await armCopyWatch(panel);
  await panel.getByRole('button', { name: button, exact: true }).click();
  await expect(panel.getByRole('button', { name: copied, exact: true })).toBeVisible();
  await assertNoDownload(panel, downloads);
  const text = await panel.evaluate(() => window.__whnCopied || '');
  expect(text).not.toBe('');
  return text;
}
