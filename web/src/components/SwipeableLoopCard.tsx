import { useRef, useState, useCallback, useEffect } from "preact/hooks";
import type { ComponentChildren } from "preact";
import type { Loop } from "../api";
import { api } from "../api";
import { showToast } from "../state";
import { signal } from "@preact/signals";
import { Trash2, Check, AlarmClock, RotateCcw } from "lucide-preact";

const ACTION_WIDTH = 72;
const SNAP_THRESHOLD = 40;
// How far past the reveal width you need to drag to trigger the action
const TRIGGER_OVERSHOOT = 120;

const activeLoopReset = signal<(() => void) | null>(null);

interface SwipeableLoopCardProps {
  loop: Loop;
  onChanged?: () => void;
  onDelete: () => Promise<void> | void;
  children: ComponentChildren;
}

export function SwipeableLoopCard({ loop, onChanged, onDelete, children }: SwipeableLoopCardProps) {
  const isClosed = loop.status === "closed";
  const rightCount = isClosed ? 1 : 2;
  const rightRevealWidth = rightCount * ACTION_WIDTH;
  const leftRevealWidth = ACTION_WIDTH;

  // Max drag = reveal + overshoot zone + some rubber-band room
  const leftMax = leftRevealWidth + TRIGGER_OVERSHOOT + 30;
  const rightMax = rightRevealWidth + TRIGGER_OVERSHOOT + 30;

  const [offsetX, setOffsetX] = useState(0);
  const [revealed, setRevealed] = useState<"left" | "right" | null>(null);
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
    setRevealed(null);
  }, []);

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

  const onTouchStart = useCallback((e: TouchEvent) => {
    const touch = e.touches[0];
    startX.current = touch.clientX;
    startY.current = touch.clientY;
    tracking.current = true;
    directionLocked.current = false;
    isHorizontal.current = false;
    setSwiping(false);
  }, []);

  const onTouchMove = useCallback((e: TouchEvent) => {
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

    if (revealed === "left") {
      // Already showing delete — allow dragging further into overshoot
      setOffsetX(Math.min(0, Math.max(-leftMax, dx - leftRevealWidth)));
    } else if (revealed === "right") {
      setOffsetX(Math.max(0, Math.min(rightMax, dx + rightRevealWidth)));
    } else {
      if (dx < 0) {
        // Swipe left — allow overshoot past reveal width
        setOffsetX(Math.max(-leftMax, dx));
      } else {
        setOffsetX(Math.min(rightMax, dx));
      }
    }
  }, [revealed, leftRevealWidth, rightRevealWidth, leftMax, rightMax]);

  const onTouchEnd = useCallback(() => {
    tracking.current = false;

    const absOffset = Math.abs(offsetX);

    // Check if we've overshot enough to trigger an action
    if (offsetX < 0 && absOffset >= leftRevealWidth + TRIGGER_OVERSHOOT) {
      // Swipe-through left → trigger delete
      handleDelete();
      return;
    }
    if (offsetX > 0 && offsetX >= rightRevealWidth + TRIGGER_OVERSHOOT) {
      // Swipe-through right → trigger leftmost action (close for open, reopen for closed)
      if (isClosed) {
        handleReopen();
      } else {
        handleClose();
      }
      return;
    }

    // Normal snap behavior
    if (revealed === "left") {
      if (offsetX > -SNAP_THRESHOLD) {
        reset();
        if (activeLoopReset.value === reset) activeLoopReset.value = null;
      } else {
        setOffsetX(-leftRevealWidth);
      }
    } else if (revealed === "right") {
      if (offsetX < SNAP_THRESHOLD) {
        reset();
        if (activeLoopReset.value === reset) activeLoopReset.value = null;
      } else {
        setOffsetX(rightRevealWidth);
      }
    } else {
      if (activeLoopReset.value && activeLoopReset.value !== reset) {
        activeLoopReset.value();
      }

      if (offsetX < -SNAP_THRESHOLD) {
        setOffsetX(-leftRevealWidth);
        setRevealed("left");
        activeLoopReset.value = reset;
      } else if (offsetX > SNAP_THRESHOLD) {
        setOffsetX(rightRevealWidth);
        setRevealed("right");
        activeLoopReset.value = reset;
      } else {
        setOffsetX(0);
      }
    }

    setTimeout(() => setSwiping(false), 10);
  }, [offsetX, revealed, reset, leftRevealWidth, rightRevealWidth, isClosed]);

  const handleDelete = useCallback(async () => {
    setRemoving(true);
    try {
      await onDelete();
    } catch {
      setRemoving(false);
      reset();
    }
  }, [onDelete, reset]);

  const handleClose = useCallback(async () => {
    try {
      await api.closeLoop(loop.id);
      showToast("Loop closed", "success");
      reset();
      onChanged?.();
    } catch {
      showToast("Failed to close loop", "error");
    }
  }, [loop.id, reset, onChanged]);

  const handleSnooze = useCallback(async () => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    try {
      await api.snoozeLoop(loop.id, d.toISOString().slice(0, 10));
      showToast("Snoozed until tomorrow", "success");
      reset();
      onChanged?.();
    } catch {
      showToast("Failed to snooze loop", "error");
    }
  }, [loop.id, reset, onChanged]);

  const handleReopen = useCallback(async () => {
    try {
      await api.reopenLoop(loop.id);
      showToast("Loop reopened", "success");
      reset();
      onChanged?.();
    } catch {
      showToast("Failed to reopen loop", "error");
    }
  }, [loop.id, reset, onChanged]);

  const handleCardClick = useCallback((e: Event) => {
    if (swiping) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (revealed) {
      e.preventDefault();
      e.stopPropagation();
      reset();
      if (activeLoopReset.value === reset) activeLoopReset.value = null;
    }
  }, [swiping, revealed, reset]);

  const isDragging = tracking.current && isHorizontal.current;

  // Progress: 0→1 for normal reveal
  const leftProgress = Math.min(1, Math.abs(Math.min(0, offsetX)) / leftRevealWidth);
  const rightProgress = Math.min(1, Math.max(0, offsetX) / rightRevealWidth);

  // Overshoot: 0→1 for the stretch beyond reveal width
  const leftOvershoot = Math.max(0, Math.abs(Math.min(0, offsetX)) - leftRevealWidth) / TRIGGER_OVERSHOOT;
  const rightOvershoot = Math.max(0, Math.max(0, offsetX) - rightRevealWidth) / TRIGGER_OVERSHOOT;

  const pillClass = "flex flex-col items-center justify-center gap-1 cursor-pointer border-0 rounded-2xl";

  const pillDynamic = (progress: number, index: number, total: number) => {
    const segmentSize = 1 / total;
    const segmentStart = index * segmentSize;
    const localProgress = Math.min(1, Math.max(0, (progress - segmentStart) / segmentSize));
    return {
      transform: `scale(${0.3 + localProgress * 0.7})`,
      opacity: localProgress,
      transition: isDragging ? "none" : "transform 0.3s cubic-bezier(0.25, 1, 0.5, 1), opacity 0.2s ease-out",
    };
  };

  // Extra pixels beyond the normal reveal width
  const leftExtraPx = Math.max(0, Math.abs(Math.min(0, offsetX)) - leftRevealWidth);
  const rightExtraPx = Math.max(0, Math.max(0, offsetX) - rightRevealWidth);

  // Outermost pill absorbs all extra space, keeping same padding to neighbors
  const stretchStyle = (extraPx: number) => {
    if (extraPx <= 0) return {};
    const clampedOvershoot = Math.min(1, extraPx / TRIGGER_OVERSHOOT);
    return {
      width: `${56 + extraPx}px`,
      transform: "scale(1)",
      opacity: 1,
      filter: `brightness(${1 + clampedOvershoot * 0.25})`,
    };
  };

  return (
    <div ref={cardRef} class={`relative ${removing ? "swipe-removing" : ""}`}>
      {/* Delete — right side, revealed on swipe left */}
      {(offsetX < 0 || revealed === "left") && (
        <div class="absolute right-0 top-0 bottom-0 flex items-center justify-center pl-2" style={{ width: `${leftRevealWidth + leftExtraPx}px` }}>
          <button
            onClick={handleDelete}
            class={pillClass}
            style={{ background: "#ef4444", color: "white", width: "56px", height: "56px", ...pillDynamic(leftProgress, 0, 1), ...stretchStyle(leftExtraPx) }}
          >
            <Trash2 class="w-5 h-5" />
            <span class="text-[10px] font-medium">Delete</span>
          </button>
        </div>
      )}

      {/* Actions — left side, revealed on swipe right */}
      {(offsetX > 0 || revealed === "right") && (
        <div
          class="absolute left-0 top-0 bottom-0 flex items-center justify-center gap-2 px-1"
          style={{ width: `${rightRevealWidth + rightExtraPx}px` }}
        >
          {isClosed ? (
            <button onClick={handleReopen} class={pillClass} style={{ background: "#3b82f6", color: "white", width: "56px", height: "56px", ...pillDynamic(rightProgress, 0, 1), ...stretchStyle(rightExtraPx) }}>
              <RotateCcw class="w-5 h-5" />
              <span class="text-[10px] font-medium">Reopen</span>
            </button>
          ) : (
            <>
              <button onClick={handleClose} class={pillClass} style={{ background: "#22c55e", color: "white", width: "56px", height: "56px", ...pillDynamic(rightProgress, 0, 2), ...stretchStyle(rightExtraPx) }}>
                <Check class="w-5 h-5" />
                <span class="text-[10px] font-medium">Close</span>
              </button>
              <button onClick={handleSnooze} class={pillClass} style={{ background: "#f59e0b", color: "white", width: "56px", height: "56px", ...pillDynamic(rightProgress, 1, 2) }}>
                <AlarmClock class="w-4 h-4" />
                <span class="text-[10px] font-medium leading-tight text-center">Snooze<br />1 day</span>
              </button>
            </>
          )}
        </div>
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
