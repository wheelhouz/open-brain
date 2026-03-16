import { useRef, useState, useCallback, useEffect } from "preact/hooks";
import type { ComponentChildren, VNode } from "preact";
import { signal } from "@preact/signals";
import { Trash2 } from "lucide-preact";

export interface SwipeAction {
  icon: VNode;
  label: string | VNode;
  color: string;
  onAction: () => Promise<void> | void;
}

interface SwipeableCardProps {
  children: ComponentChildren;
  /** Actions revealed on swipe left (shown on right side). Default: delete button using onDelete. */
  leftActions?: SwipeAction[];
  /** Actions revealed on swipe right (shown on left side). */
  rightActions?: SwipeAction[];
  /** Shorthand for a single delete action on swipe left. Ignored if leftActions is provided. */
  onDelete?: () => Promise<void> | void;
}

const ACTION_WIDTH = 72;
const SNAP_THRESHOLD = 40;
const TRIGGER_OVERSHOOT = 120;
const PILL_SIZE = 56;

const activeReset = signal<(() => void) | null>(null);

export function SwipeableCard({ children, leftActions: leftActionsProp, rightActions, onDelete }: SwipeableCardProps) {
  // Build left actions: explicit prop, or default delete button from onDelete
  const leftActions: SwipeAction[] = leftActionsProp || (onDelete ? [{
    icon: <Trash2 class="w-5 h-5" />,
    label: "Delete",
    color: "#ef4444",
    onAction: onDelete,
  }] : []);

  const hasLeft = leftActions.length > 0;
  const hasRight = !!rightActions && rightActions.length > 0;

  const leftRevealWidth = leftActions.length * ACTION_WIDTH;
  const rightRevealWidth = (rightActions?.length || 0) * ACTION_WIDTH;
  const leftMax = hasLeft ? leftRevealWidth + TRIGGER_OVERSHOOT + 30 : 0;
  const rightMax = hasRight ? rightRevealWidth + TRIGGER_OVERSHOOT + 30 : 0;

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
      setOffsetX(Math.min(0, Math.max(-leftMax, dx - leftRevealWidth)));
    } else if (revealed === "right") {
      setOffsetX(Math.max(0, Math.min(rightMax, dx + rightRevealWidth)));
    } else {
      if (dx < 0 && hasLeft) {
        setOffsetX(Math.max(-leftMax, dx));
      } else if (dx > 0 && hasRight) {
        setOffsetX(Math.min(rightMax, dx));
      }
    }
  }, [revealed, leftRevealWidth, rightRevealWidth, leftMax, rightMax, hasLeft, hasRight]);

  const triggerAction = useCallback(async (action: SwipeAction) => {
    setRemoving(true);
    try {
      await action.onAction();
    } catch {
      setRemoving(false);
      reset();
    }
  }, [reset]);

  const onTouchEnd = useCallback(() => {
    tracking.current = false;

    const absOffset = Math.abs(offsetX);

    // Swipe-through triggers
    if (offsetX < 0 && hasLeft && absOffset >= leftRevealWidth + TRIGGER_OVERSHOOT) {
      // Trigger last action (outermost on right side = last in leftActions array)
      triggerAction(leftActions[leftActions.length - 1]);
      return;
    }
    if (offsetX > 0 && hasRight && offsetX >= rightRevealWidth + TRIGGER_OVERSHOOT) {
      // Trigger first action (outermost on left side = first in rightActions array)
      triggerAction(rightActions![0]);
      return;
    }

    // Normal snap
    if (revealed === "left") {
      if (offsetX > -SNAP_THRESHOLD) {
        reset();
        if (activeReset.value === reset) activeReset.value = null;
      } else {
        setOffsetX(-leftRevealWidth);
      }
    } else if (revealed === "right") {
      if (offsetX < SNAP_THRESHOLD) {
        reset();
        if (activeReset.value === reset) activeReset.value = null;
      } else {
        setOffsetX(rightRevealWidth);
      }
    } else {
      if (activeReset.value && activeReset.value !== reset) {
        activeReset.value();
      }

      if (offsetX < -SNAP_THRESHOLD && hasLeft) {
        setOffsetX(-leftRevealWidth);
        setRevealed("left");
        activeReset.value = reset;
      } else if (offsetX > SNAP_THRESHOLD && hasRight) {
        setOffsetX(rightRevealWidth);
        setRevealed("right");
        activeReset.value = reset;
      } else {
        setOffsetX(0);
      }
    }

    setTimeout(() => setSwiping(false), 10);
  }, [offsetX, revealed, reset, leftRevealWidth, rightRevealWidth, hasLeft, hasRight, leftActions, rightActions, triggerAction]);

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
      if (activeReset.value === reset) activeReset.value = null;
    }
  }, [swiping, revealed, reset]);

  const isDragging = tracking.current && isHorizontal.current;

  const leftProgress = hasLeft ? Math.min(1, Math.abs(Math.min(0, offsetX)) / leftRevealWidth) : 0;
  const rightProgress = hasRight ? Math.min(1, Math.max(0, offsetX) / rightRevealWidth) : 0;
  const leftExtraPx = hasLeft ? Math.max(0, Math.abs(Math.min(0, offsetX)) - leftRevealWidth) : 0;
  const rightExtraPx = hasRight ? Math.max(0, Math.max(0, offsetX) - rightRevealWidth) : 0;

  const pillClass = "flex flex-col items-center justify-center gap-1 cursor-pointer border-0 rounded-2xl";

  const pillDynamic = (progress: number, index: number, total: number) => {
    // Stagger start points but give each button a wide ramp (70% of total range)
    // so they ease in gradually with overlap rather than popping abruptly
    const staggerStart = total <= 1 ? 0 : (index / (total - 1)) * 0.4;
    const rampSize = total <= 1 ? 1 : 0.7;
    const localProgress = Math.min(1, Math.max(0, (progress - staggerStart) / rampSize));
    // Apply an ease-out curve for smoother deceleration
    const eased = 1 - Math.pow(1 - localProgress, 2.5);
    return {
      transform: `scale(${0.3 + eased * 0.7})`,
      opacity: eased,
      transition: isDragging ? "none" : "transform 0.35s cubic-bezier(0.25, 1, 0.5, 1), opacity 0.3s ease-out",
    };
  };

  const stretchStyle = (extraPx: number) => {
    if (extraPx <= 0) return {};
    const clampedOvershoot = Math.min(1, extraPx / TRIGGER_OVERSHOOT);
    return {
      width: `${PILL_SIZE + extraPx}px`,
      transform: "scale(1)",
      opacity: 1,
      filter: `brightness(${1 + clampedOvershoot * 0.25})`,
    };
  };

  const renderActions = (
    actions: SwipeAction[],
    progress: number,
    extraPx: number,
    stretchIndex: number, // which action gets the stretch (0 = first, -1 = last)
  ) =>
    actions.map((action, i) => {
      const isStretched = i === (stretchIndex < 0 ? actions.length - 1 : stretchIndex);
      return (
        <button
          key={i}
          onClick={() => triggerAction(action)}
          class={pillClass}
          style={{
            background: action.color,
            color: "white",
            width: `${PILL_SIZE}px`,
            height: `${PILL_SIZE}px`,
            ...pillDynamic(progress, i, actions.length),
            ...(isStretched ? stretchStyle(extraPx) : {}),
          }}
        >
          {action.icon}
          <span class="text-[10px] font-medium leading-tight text-center">{action.label}</span>
        </button>
      );
    });

  return (
    <div ref={cardRef} class={`relative ${removing ? "swipe-removing" : ""}`}>
      {/* Left actions (right side) — revealed on swipe left */}
      {hasLeft && (offsetX < 0 || revealed === "left") && (
        <div
          class="absolute right-0 top-0 bottom-0 flex items-center justify-center gap-2 pl-2"
          style={{ width: `${leftRevealWidth + leftExtraPx}px` }}
        >
          {renderActions(leftActions, leftProgress, leftExtraPx, -1)}
        </div>
      )}

      {/* Right actions (left side) — revealed on swipe right */}
      {hasRight && (offsetX > 0 || revealed === "right") && (
        <div
          class="absolute left-0 top-0 bottom-0 flex items-center justify-center gap-2 px-1"
          style={{ width: `${rightRevealWidth + rightExtraPx}px` }}
        >
          {renderActions(rightActions!, rightProgress, rightExtraPx, 0)}
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
