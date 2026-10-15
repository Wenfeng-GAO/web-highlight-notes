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

export const DEFAULT_LABELS = {
  source: '来源：',
  summary: '摘要',
  highlights: '划线',
  comment: '评论：',
  defaultName: '划线笔记',
};

export function toMarkdown({ title, url, date, summary, highlights, labels = DEFAULT_LABELS }) {
  const l = { ...DEFAULT_LABELS, ...labels };
  const lines = [
    `# ${title ?? ''}`,
    `${l.source}${url ?? ''} · ${date ?? ''}`,
    `## ${l.summary}`,
    summary ?? '',
    `## ${l.highlights}`,
  ];
  for (const highlight of highlights || []) {
    lines.push(quoteBlock(highlight.text ?? ''));
    const comment = (highlight.comment ?? '').trim();
    if (comment) lines.push(`${l.comment}${comment}`);
  }
  return `${lines.join('\n')}\n`;
}

export function downloadFilename(title, fallback = DEFAULT_LABELS.defaultName) {
  const cleaned = String(title || fallback)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return `${cleaned || fallback}.md`;
}
