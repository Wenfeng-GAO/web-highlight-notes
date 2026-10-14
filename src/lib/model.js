export function emptyRecord(url) {
  return {
    url,
    title: '',
    summary: '',
    highlights: [],
  };
}

export function hasComment(highlight) {
  return !!(highlight?.comment || '').trim();
}

export function commentCount(highlights) {
  return (highlights || []).filter(hasComment).length;
}

export function compareHighlights(a, b) {
  const pa = typeof a.pos === 'number' ? a.pos : Number.MAX_SAFE_INTEGER;
  const pb = typeof b.pos === 'number' ? b.pos : Number.MAX_SAFE_INTEGER;
  if (pa !== pb) return pa - pb;
  return (a.createdAt || 0) - (b.createdAt || 0);
}

export function sortHighlights(highlights) {
  return [...(highlights || [])].sort(compareHighlights);
}

export function toStoredRecord(record) {
  return {
    url: record.url,
    title: record.title || '',
    summary: record.summary || '',
    highlights: (record.highlights || []).map((highlight) => ({
      id: highlight.id,
      text: highlight.text || '',
      prefix: highlight.prefix || '',
      suffix: highlight.suffix || '',
      comment: highlight.comment || '',
      draft: highlight.draft ?? null,
      createdAt: highlight.createdAt || 0,
      pos: typeof highlight.pos === 'number' ? highlight.pos : null,
      anchored: typeof highlight.anchored === 'boolean' ? highlight.anchored : null,
    })),
  };
}

export function canonicalRecord(record) {
  return JSON.stringify(toStoredRecord(record || emptyRecord('')));
}

export function sameRecord(a, b) {
  return canonicalRecord(a) === canonicalRecord(b);
}
