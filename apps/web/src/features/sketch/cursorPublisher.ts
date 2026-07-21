import type { AwarenessCursor } from "@architect/contracts";

type CreateBoundedCursorPublisherOptions = {
  intervalMs?: number;
  onPublish: (cursor: AwarenessCursor) => void;
};

function isMeaningfulMove(
  previous: AwarenessCursor | null,
  next: AwarenessCursor,
): boolean {
  if (!previous) return true;
  const deltaX = next.x - previous.x;
  const deltaY = next.y - previous.y;
  return deltaX * deltaX + deltaY * deltaY >= 4;
}

export function createBoundedCursorPublisher({
  intervalMs = 50,
  onPublish,
}: CreateBoundedCursorPublisherOptions) {
  if (!Number.isFinite(intervalMs) || intervalMs < 16 || intervalMs > 1_000) {
    throw new Error("Invalid cursor publication interval");
  }

  let destroyed = false;
  let lastPublished: AwarenessCursor | null = null;
  let nextAllowedAt = 0;
  let pending: AwarenessCursor | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const publish = (cursor: AwarenessCursor) => {
    lastPublished = cursor;
    nextAllowedAt = Date.now() + intervalMs;
    onPublish({ ...cursor });
  };

  const flush = () => {
    timer = null;
    if (destroyed || !pending) return;
    const cursor = pending;
    pending = null;
    if (isMeaningfulMove(lastPublished, cursor)) publish(cursor);
  };

  return {
    move(cursor: AwarenessCursor): void {
      if (
        destroyed ||
        !Number.isFinite(cursor.x) ||
        !Number.isFinite(cursor.y) ||
        !isMeaningfulMove(pending ?? lastPublished, cursor)
      ) {
        return;
      }
      const next = { x: cursor.x, y: cursor.y };
      if (Date.now() >= nextAllowedAt && !timer) {
        publish(next);
        return;
      }
      pending = next;
      if (!timer) {
        timer = setTimeout(flush, Math.max(0, nextAllowedAt - Date.now()));
      }
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      pending = null;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
