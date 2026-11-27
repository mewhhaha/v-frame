/**
 * Finds the index immediately past the end of an HTML5 comment starting at
 * `tagStart` (`source.startsWith("<!--", tagStart)`), honoring abrupt endings
 * (`<!-->`, `<!--->`) as well as both `-->` and `--!>` (`comment-end-bang-state`).
 * Returns `-1` when the comment reaches EOF unclosed.
 */
export function findHTMLCommentEnd(source: string, tagStart: number): number {
  if (source.startsWith("<!-->", tagStart)) {
    return tagStart + 5;
  }
  if (source.startsWith("<!--->", tagStart)) {
    return tagStart + 6;
  }
  const standardEnd = source.indexOf("-->", tagStart + 4);
  const bangEnd = source.indexOf("--!>", tagStart + 4);
  if (standardEnd === -1 && bangEnd === -1) {
    return -1;
  }
  if (bangEnd !== -1 && (standardEnd === -1 || bangEnd < standardEnd)) {
    return bangEnd + 4;
  }
  return standardEnd + 3;
}
