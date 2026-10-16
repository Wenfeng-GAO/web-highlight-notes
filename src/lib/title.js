/**
 * Which title names a page after a same-document navigation (pushState,
 * replaceState, back/forward).
 *
 * `leftover` is the title of the view we just left. Single-page apps often
 * leave document.title unchanged until the next view renders, so `live` can
 * still be that leftover. `stored` is the title already saved for the
 * destination.
 *
 * A leftover must not replace a stored title (the panel would flash the
 * previous page). A live title that has actually changed is the page the user
 * is on. When nothing is stored and the document has not renamed itself yet,
 * return '' so the previous view's name is not written onto the new page.
 */
export function titleAfterNavigation({ stored = '', leftover = '', live = '' } = {}) {
  const storedTitle = stored || '';
  const liveTitle = live || '';
  const inherited = leftover || '';
  if (liveTitle && liveTitle !== inherited) return liveTitle;
  return storedTitle;
}
