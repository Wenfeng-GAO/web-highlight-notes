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

const FILENAME_MAX_UNITS = 80;

/**
 * At most 80 UTF-16 code units.
 * Intl.Segmenter keeps a grapheme intact by dropping a cluster that would not fit.
 * Without Segmenter this only avoids splitting one surrogate pair. Combining marks
 * and ZWJ sequences can still be cut on that path.
 */
function truncateFilename(text) {
  if (text.length <= FILENAME_MAX_UNITS) return text;
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    let out = '';
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    for (const { segment } of segmenter.segment(text)) {
      if (out.length + segment.length > FILENAME_MAX_UNITS) break;
      out += segment;
    }
    return out;
  }
  let end = FILENAME_MAX_UNITS;
  const lead = text.charCodeAt(end - 1);
  const trail = text.charCodeAt(end);
  if (lead >= 0xD800 && lead <= 0xDBFF && trail >= 0xDC00 && trail <= 0xDFFF) end -= 1;
  return text.slice(0, end);
}

export function downloadFilename(title, fallback = DEFAULT_LABELS.defaultName) {
  const cleaned = truncateFilename(String(title || fallback)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim());
  return `${cleaned || fallback}.md`;
}
