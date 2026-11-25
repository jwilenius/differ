// Overview ruler shared by jw-differ's diff and merge pages: a narrow strip at
// the right edge marking where the changes sit in the whole file, with a box
// over the part on screen. The geometry is plain top-level functions, so tests
// can load this file in a bare VM context; `attachOverviewRuler` wires a ruler
// to the pane the view scrolls by.
//
// Content offsets are pixels inside that pane's scrolled content; ruler offsets
// are pixels down the ruler, which shows the whole content scaled to its height.

/** The least height of a change's mark, so a one-line change and an empty range still show. */
const OVERVIEW_MIN_MARK_HEIGHT = 3;
/** The least height of the box over the visible part, so it can still be grabbed in a long file. */
const OVERVIEW_MIN_BOX_HEIGHT = 10;

/** Ruler pixels per content pixel. */
function overviewScale(contentHeight, rulerHeight) {
  return contentHeight > 0 ? rulerHeight / contentHeight : 0;
}

/** A ruler span of at least `minHeight` centred on the ruler offset `centre`, kept on the ruler: `{ top, height }`. */
function overviewSpan(centre, height, minHeight, rulerHeight) {
  const spanHeight = Math.min(Math.max(height, minHeight), rulerHeight);
  const top = Math.min(Math.max(centre - spanHeight / 2, 0), rulerHeight - spanHeight);
  return { top, height: spanHeight };
}

/** Where the mark of a change covering content `band` (`{ top, bottom }`) sits on the ruler: `{ top, height }`. */
function overviewMark(band, contentHeight, rulerHeight) {
  const scale = overviewScale(contentHeight, rulerHeight);
  const centre = ((band.top + band.bottom) / 2) * scale;
  return overviewSpan(centre, (band.bottom - band.top) * scale, OVERVIEW_MIN_MARK_HEIGHT, rulerHeight);
}

/** Where the box over the visible part, `viewport` (`{ top, height }` of the content), sits on the ruler: `{ top, height }`. */
function overviewViewportBox(viewport, contentHeight, rulerHeight) {
  const scale = overviewScale(contentHeight, rulerHeight);
  return overviewSpan((viewport.top + viewport.height / 2) * scale, viewport.height * scale, OVERVIEW_MIN_BOX_HEIGHT, rulerHeight);
}

/** The content offset, or distance, that a ruler offset, or distance, stands for. */
function overviewContentOffset(rulerOffset, contentHeight, rulerHeight) {
  return rulerHeight > 0 ? (rulerOffset * contentHeight) / rulerHeight : 0;
}

/**
 * Wires the ruler element `ruler` to `scroller`, the pane the view scrolls by: a click scrolls to centre the point
 * clicked, dragging moves the view along, and the box follows every scroll. Returns `drawMarks(bands)`, which redraws
 * the marks of changes `{ top, bottom, kind, isCurrent }` (content offsets; `kind` picks the mark's
 * `overview-<kind>` class) and the box: call it whenever the changes, their layout or the ruler's height change, not
 * on scroll.
 */
function attachOverviewRuler(ruler, scroller) {
  const marks = document.createElement("div");
  marks.className = "overview-marks";
  const box = document.createElement("div");
  box.className = "overview-viewport";
  ruler.append(marks, box);
  /** Where a drag started: the pointer's ruler offset and the pane's scroll offset then; null while none is under way. */
  let drag = null;

  function viewportBox() {
    const viewport = { top: scroller.scrollTop, height: scroller.clientHeight };
    return overviewViewportBox(viewport, scroller.scrollHeight, ruler.clientHeight);
  }

  function moveViewport() {
    const { top, height } = viewportBox();
    box.style.top = `${top}px`;
    box.style.height = `${height}px`;
  }

  function drawMarks(bands) {
    const contentHeight = scroller.scrollHeight;
    const rulerHeight = ruler.clientHeight;
    marks.replaceChildren(...bands.map((band) => markElement(band, contentHeight, rulerHeight)));
    moveViewport();
  }

  function markElement(band, contentHeight, rulerHeight) {
    const { top, height } = overviewMark(band, contentHeight, rulerHeight);
    const mark = document.createElement("div");
    mark.className = `overview-mark overview-${band.kind}${band.isCurrent ? " is-current" : ""}`;
    mark.style.top = `${top}px`;
    mark.style.height = `${height}px`;
    return mark;
  }

  function rulerOffsetOf(event) {
    return event.clientY - ruler.getBoundingClientRect().top;
  }

  /** Off the box, jumps there first; either way the drag then moves the view as far as the pointer moves. */
  function startDrag(event) {
    if (event.button !== 0) {
      return;
    }
    const offset = rulerOffsetOf(event);
    const { top, height } = viewportBox();
    const isOnBox = offset >= top && offset <= top + height;
    if (!isOnBox) {
      const contentOffset = overviewContentOffset(offset, scroller.scrollHeight, ruler.clientHeight);
      scroller.scrollTop = contentOffset - scroller.clientHeight / 2;
    }
    drag = { offset, scrollTop: scroller.scrollTop };
    ruler.setPointerCapture(event.pointerId);
    ruler.classList.toggle("is-dragging", true);
  }

  function continueDrag(event) {
    if (drag === null) {
      return;
    }
    const distance = rulerOffsetOf(event) - drag.offset;
    scroller.scrollTop = drag.scrollTop + overviewContentOffset(distance, scroller.scrollHeight, ruler.clientHeight);
  }

  function endDrag() {
    drag = null;
    ruler.classList.toggle("is-dragging", false);
  }

  ruler.addEventListener("pointerdown", startDrag);
  ruler.addEventListener("pointermove", continueDrag);
  ruler.addEventListener("pointerup", endDrag);
  ruler.addEventListener("lostpointercapture", endDrag);
  // The pointer leaves focus, the caret and any selection where they are, as on a scrollbar.
  ruler.addEventListener("mousedown", (event) => event.preventDefault());
  scroller.addEventListener("scroll", moveViewport, { passive: true });
  return { drawMarks };
}
