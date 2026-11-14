// Geometry shared by Differ's diff and merge clients. Plain top-level
// functions, so tests can load this file in a bare VM context and call them.
//
// Positions are measured in lines: every `.line` has the same height, so a
// line index times the line height is its offset inside its scroller.

/**
 * Corresponding points of the two sides, in order: the start, both edges of
 * every block, and the end. Between two anchors the sides map linearly — 1:1
 * between blocks, proportionally inside one.
 */
function buildAnchors(blocks, baseLineCount, resultLineCount) {
  const anchors = [{ base: 0, result: 0 }];
  for (const block of blocks) {
    anchors.push({ base: block.base[0], result: block.result[0] });
    anchors.push({ base: block.base[1], result: block.result[1] });
  }
  anchors.push({ base: baseLineCount, result: resultLineCount });
  return anchors;
}

/** Maps a (fractional) line of side `from` to the matching line of side `to`. */
function mapLine(anchors, line, from, to) {
  for (let index = 0; index + 1 < anchors.length; index++) {
    const start = anchors[index];
    const end = anchors[index + 1];
    const span = end[from] - start[from];
    const isInSegment = span > 0 && line >= start[from] && line <= end[from];
    if (isInSegment) {
      return start[to] + ((line - start[from]) / span) * (end[to] - start[to]);
    }
  }
  const last = anchors[anchors.length - 1];
  const edge = line < 0 ? anchors[0] : last;
  return edge[to] + (line - edge[from]);
}

/**
 * The scroll offset that shows, at the middle of the target viewport, what
 * sits at the middle of the source viewport. Both ends stay pinned so the
 * first and last lines are always reachable on both sides.
 *
 * `source` is { top, height, max }; `target` is { height, max }.
 */
function syncedScrollTop(anchors, from, to, source, target, lineHeight) {
  if (source.top <= 0) {
    return 0;
  }
  if (source.top >= source.max) {
    return target.max;
  }
  const centreLine = (source.top + source.height / 2) / lineHeight;
  const mapped = mapLine(anchors, centreLine, from, to) * lineHeight - target.height / 2;
  return Math.min(Math.max(mapped, 0), target.max);
}

/**
 * IntelliJ's ribbon: a band joining the left block [leftTop, leftBottom] to the
 * right block [rightTop, rightBottom] with S-curves; an empty side tapers to a point.
 */
function connectorPath(width, leftTop, leftBottom, rightTop, rightBottom) {
  const middle = width / 2;
  return [
    `M0,${leftTop}`,
    `C${middle},${leftTop} ${middle},${rightTop} ${width},${rightTop}`,
    `L${width},${rightBottom}`,
    `C${middle},${rightBottom} ${middle},${leftBottom} 0,${leftBottom}`,
    "Z",
  ].join(" ");
}

/** Whether a vertical band [top, bottom] touches the visible strip [0, height]. */
function isBandVisible(top, bottom, height) {
  return bottom >= 0 && top <= height;
}

/**
 * The block after (`direction` 1) or before (-1) `line` on `side`, ignoring a
 * block starting within half a line of it; -1 when there is none.
 */
function neighbourBlock(blocks, side, line, direction) {
  if (direction > 0) {
    return blocks.findIndex((block) => block[side][0] > line + 0.5);
  }
  for (let index = blocks.length - 1; index >= 0; index--) {
    if (blocks[index][side][0] < line - 0.5) {
      return index;
    }
  }
  return -1;
}
