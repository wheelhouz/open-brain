import { useRef, useState, useCallback, useEffect } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { signal } from "@preact/signals";
import { Trash2 } from "lucide-preact";

interface SwipeableCardProps {
  children: ComponentChildren;
  onDelete: () => Promise<void> | void;
}

const REVEAL_WIDTH = 80;
const SNAP_THRESHOLD = 60;

// Shared signal: holds the reset function of the currently revealed card
const activeReset = signal<(() => void) | null>(null);

export function SwipeableCard({ children, onDelete }: SwipeableCardProps) {
  const [offsetX, setOffsetX] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [swiping, setSwiping] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  const startX = useRef(0);
  const startY = useRef(0);
  const tracking = useRef(false);
  const directionLocked = useRef(false);
  const isHorizontal = useRef(false);

  const reset = useCallback(() => {
    setOffsetX(0);
    setRevealed(false);
  }, []);

  // Close on scroll: find nearest scrollable ancestor and listen
  useEffect(() => {
    if (!revealed) return;
    let scrollParent: HTMLElement | null = cardRef.current?.parentElement ?? null;
    while (scrollParent && scrollParent.scrollHeight <= scrollParent.clientHeight) {
      scrollParent = scrollParent.parentElement;
    }
    if (!scrollParent) return;
    const onScroll = () => reset();
    scrollParent.addEventListener("scroll", onScroll, { passive: true });
    return () => scrollParent!.removeEventListener("scroll", onScroll);
  }, [revealed, reset]);

  const onTouchStart = useCallback(
    (e: TouchEvent) => {
      const touch = e.touches[0];
      startX.current = touch.clientX;
      startY.current = touch.clientY;
      tracking.current = true;
      directionLocked.current = false;
      isHorizontal.current = false;
      setSwiping(false);
    },
    [],
  );

  const onTouchMove = useCallback(
    (e: TouchEvent) => {
      if (!tracking.current) return;

      const touch = e.touches[0];
      const dx = touch.clientX - startX.current;
      const dy = touch.clientY - startY.current;

      if (!directionLocked.current) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        directionLocked.current = true;
        isHorizontal.current = Math.abs(dx) > Math.abs(dy);
        if (!isHorizontal.current) {
          tracking.current = false;
          return;
        }
      }

      if (!isHorizontal.current) return;

      e.preventDefault();
      setSwiping(true);

      if (revealed) {
        const newOffset = Math.min(0, Math.max(-REVEAL_WIDTH, dx - REVEAL_WIDTH));
        setOffsetX(newOffset);
      } else {
        const newOffset = Math.min(0, Math.max(-REVEAL_WIDTH, dx));
        setOffsetX(newOffset);
      }
    },
    [revealed],
  );

  const onTouchEnd = useCallback(() => {
    tracking.current = false;

    if (revealed) {
      if (offsetX > -SNAP_THRESHOLD) {
        reset();
        if (activeReset.value === reset) activeReset.value = null;
      } else {
        setOffsetX(-REVEAL_WIDTH);
      }
    } else {
      if (offsetX < -SNAP_THRESHOLD) {
        // Dismiss any other revealed card first
        if (activeReset.value && activeReset.value !== reset) {
          activeReset.value();
        }
        setOffsetX(-REVEAL_WIDTH);
        setRevealed(true);
        activeReset.value = reset;
      } else {
        setOffsetX(0);
      }
    }

    setTimeout(() => setSwiping(false), 10);
  }, [offsetX, revealed, reset]);

  const handleDelete = useCallback(async () => {
    setRemoving(true);
    try {
      await onDelete();
    } catch {
      setRemoving(false);
      reset();
    }
  }, [onDelete, reset]);

  const handleCardClick = useCallback(
    (e: Event) => {
      if (swiping) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (revealed) {
        e.preventDefault();
        e.stopPropagation();
        reset();
        if (activeReset.value === reset) activeReset.value = null;
      }
    },
    [swiping, revealed, reset],
  );

  const isDragging = tracking.current && isHorizontal.current;
  const progress = Math.min(1, Math.abs(offsetX) / REVEAL_WIDTH);

  return (
    <div ref={cardRef} class={`swipeable-card relative overflow-hidden rounded-lg ${removing ? "swipe-removing" : ""}`}>
      {/* Delete action behind the card — only render when swiped */}
      {(offsetX < 0 || revealed) && (
      <button
        onClick={handleDelete}
        class="absolute right-0 top-0 bottom-0 flex items-center justify-center gap-1.5 cursor-pointer border-0 rounded-r-lg"
        style={{
          width: `${REVEAL_WIDTH}px`,
          background: `linear-gradient(135deg, #dc2626 0%, #ef4444 100%)`,
          color: "white",
          fontSize: "0.75rem",
          fontWeight: 500,
        }}
      >
        <Trash2
          class="w-4 h-4 transition-transform"
          style={{ transform: `scale(${0.8 + progress * 0.4})` }}
        />
        <span
          class="transition-opacity"
          style={{ opacity: progress > 0.5 ? 1 : 0 }}
        >
          Delete
        </span>
      </button>
      )}

      {/* Card content */}
      <div
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onClickCapture={handleCardClick}
        class="relative z-[1]"
        style={{
          transform: `translateX(${offsetX}px)`,
          transition: isDragging ? "none" : "transform 0.3s cubic-bezier(0.25, 1, 0.5, 1)",
          touchAction: "pan-y",
        }}
      >
        {children}
      </div>
    </div>
  );
}
