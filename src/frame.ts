/**
 * 把高频回调压到一帧一次。
 *
 * 拖选时 CodeMirror 每个 mousemove 都发一次更新，如果在更新回调里立刻读 scrollHeight
 * 这类几何量，就会在 CM 自己的测量之前强制一次同步布局：写样式 → 读几何 → 再写样式，
 * 一帧里布局两遍，手感就是轻微卡顿。挪到 rAF 里之后，读写都发生在 CM 测量之后。
 */
export function perFrame(fn: () => void): () => void {
  let queued = false;
  return () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn();
    });
  };
}