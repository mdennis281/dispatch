/**
 * Copying a message out of the transcript without the layout's newlines.
 *
 * Triple-clicking a message, or dragging to just past its last line, leaves the
 * selection's far end on the NEXT row's header (and a drag starting in the gap
 * above leaves the near end on the previous row's last text). Nothing visible
 * lies in between, but Chrome serializes a line break for every block boundary
 * the range crosses — the `<p>`, the markdown wrapper, RowShell's columns, the
 * `cm-row-cv` wrapper — so the clipboard got the message wrapped in `\r\n\r\n`.
 *
 * Trimming the copied text would be wrong: a message can legitimately start or
 * end with blank lines (a user bubble is `pre-wrap`). So instead the selection
 * is intersected with the one message body it actually touches, and only kept
 * when that changes nothing but whitespace. Whitespace INSIDE the body is never
 * touched; whitespace that exists only because of the DOM around it is.
 */

/** Marks a row's message body — the region a single-message copy is clamped to. */
export const COPY_BODY_ATTR = "data-copy-body";

/**
 * Call from a `copy` handler, before the browser serializes the selection. May
 * replace the selection with its intersection with one message body; the native
 * copy then runs on that, so text/html rich paste keeps working.
 */
export function clampSelectionToMessage(root: HTMLElement): void {
  const sel = root.ownerDocument.getSelection();
  if (!sel || sel.rangeCount !== 1 || sel.isCollapsed) return;
  const range = sel.getRangeAt(0);

  // Bodies holding selected TEXT. A body the range merely brushes (its end
  // offset sitting on the previous row's last character) intersects but
  // contributes nothing, so it must not count as a second message.
  const touched: Range[] = [];
  for (const body of root.querySelectorAll(`[${COPY_BODY_ATTR}]`)) {
    if (!range.intersectsNode(body)) continue;
    // Bodies nest (a ShellRunGroup's RowShell holds an embedded DispatchToolCard,
    // itself a RowShell). The row is the message, so only the outermost counts —
    // otherwise the pair reads as two messages and the clamp never fires there.
    if (body.parentElement?.closest(`[${COPY_BODY_ATTR}]`)) continue;
    const part = intersect(range, body);
    if (part.toString().trim()) touched.push(part);
  }
  // Zero: nothing to clamp to. Two or more: the user is copying a stretch of
  // transcript, and the breaks between rows are then real separators.
  if (touched.length !== 1) return;
  const clamped = touched[0]!;
  if (
    clamped.compareBoundaryPoints(Range.START_TO_START, range) === 0 &&
    clamped.compareBoundaryPoints(Range.END_TO_END, range) === 0
  ) {
    return;
  }

  const before = sel.toString();
  sel.removeAllRanges();
  sel.addRange(clamped);
  // Anything visible outside the body (the "Claude · 13:45" header, a chip) was
  // selected on purpose — put the original back rather than drop it.
  if (sel.toString().trim() !== before.trim()) {
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

function intersect(range: Range, node: Node): Range {
  const out = node.ownerDocument!.createRange();
  out.selectNodeContents(node);
  if (range.compareBoundaryPoints(Range.START_TO_START, out) > 0) {
    out.setStart(range.startContainer, range.startOffset);
  }
  if (range.compareBoundaryPoints(Range.END_TO_END, out) < 0) {
    out.setEnd(range.endContainer, range.endOffset);
  }
  return out;
}
