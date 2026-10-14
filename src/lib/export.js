/** Pure Markdown export. Callers pass highlights already sorted in page order. */

export function formatDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function quoteBlock(text) {
  const lines = String(text ?? '').split('\n');
  return lines.map((line) => `> ${line}`).join('\n');
}

export function toMarkdown({ title, url, date, summary, highlights }) {
  const lines = [
    `# ${title ?? ''}`,
    `来源：${url ?? ''} · ${date ?? ''}`,
    '## 摘要',
    summary ?? '',
    '## 划线',
  ];
  for (const highlight of highlights || []) {
    lines.push(quoteBlock(highlight.text ?? ''));
    const comment = (highlight.comment ?? '').trim();
    if (comment) lines.push(`评论：${comment}`);
  }
  return `${lines.join('\n')}\n`;
}

export function downloadFilename(title) {
  const cleaned = String(title || '划线笔记')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return `${cleaned || '划线笔记'}.md`;
}
