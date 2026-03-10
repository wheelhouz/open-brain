import { useRef, useCallback, useState, useEffect } from "preact/hooks";
import type { ComponentChildren } from "preact";

interface BottomSheetProps {
  children: ComponentChildren;
  onClose: () => void;
  size?: "full" | "half";
  blur?: boolean;
}

const DISMISS_THRESHOLD = 80;
const SNAP_UP_THRESHOLD = 40;

const KEYBOARD_THRESHOLD = 150;

function useVisualViewport() {
  const [height, setHeight] = useState<number | null>(
    typeof window !== "undefined" && window.visualViewport
      ? window.visualViewport.height
      : null,
  );
  const [offsetTop, setOffsetTop] = useState(0);
  const [keyboardOpen, setKeyboardOpen] = useState(false);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onUpdate = () => {
      setHeight(vv.height);
      setOffsetTop(vv.offsetTop);
      setKeyboardOpen(window.innerHeight - vv.height > KEYBOARD_THRESHOLD);
    };
    vv.addEventListener("resize", onUpdate);
    vv.addEventListener("scroll", onUpdate);
    return () => {
      vv.removeEventListener("resize", onUpdate);
      vv.removeEventListener("scroll", onUpdate);
    };
  }, []);

  return { height, offsetTop, keyboardOpen };
}

export function BottomSheet({ children, onClose, size = "full", blur = true }: BottomSheetProps) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const gripperRef = useRef<HTMLDivElement>(null);
  const [dragY, setDragY] = useState(0);
  const [dismissing, setDismissing] = useState(false);
  const [snappedFull, setSnappedFull] = useState(false);
  const startY = useRef(0);
  const tracking = useRef(false);
  const fromGripper = useRef(false);
  const { height: vvHeight, offsetTop: vvOffsetTop, keyboardOpen } = useVisualViewport();

  const onTouchStart = useCallback((e: TouchEvent) => {
    const sheet = sheetRef.current;
    if (!sheet) return;
    // Only allow drag when scrolled to top
    if (sheet.scrollTop > 0) return;
    // Let textareas handle their own scrolling
    const target = e.target as HTMLElement;
    if (target.closest("textarea")) return;
    startY.current = e.touches[0].clientY;
    tracking.current = true;
    // Check if touch started on the gripper
    fromGripper.current = gripperRef.current?.contains(e.target as Node) ?? false;
  }, []);

  const onTouchMove = useCallback((e: TouchEvent) => {
    if (!tracking.current) return;
    const dy = e.touches[0].clientY - startY.current;

    // Upward drags only from gripper
    if (dy < 0 && !fromGripper.current) {
      tracking.current = false;
      setDragY(0);
      return;
    }

    if (snappedFull) {
      if (dy < 0) {
        // Full + swipe up on gripper — stop, let scroll take over
        tracking.current = false;
        setDragY(0);
        return;
      }
      // Full + swipe down on gripper — track for snap-back
      e.preventDefault();
      const dampened = dy < SNAP_UP_THRESHOLD ? dy : SNAP_UP_THRESHOLD + (dy - SNAP_UP_THRESHOLD) * 0.3;
      setDragY(dampened);
    } else {
      if (dy < 0) {
        // Not full + swipe up on gripper — track for snap-to-full
        e.preventDefault();
        const dampened = dy > -SNAP_UP_THRESHOLD ? dy : -SNAP_UP_THRESHOLD + (dy + SNAP_UP_THRESHOLD) * 0.3;
        setDragY(dampened);
      } else {
        // Not full + swipe down — dismiss behavior
        e.preventDefault();
        const dampened = dy < DISMISS_THRESHOLD ? dy : DISMISS_THRESHOLD + (dy - DISMISS_THRESHOLD) * 0.3;
        setDragY(dampened);
      }
    }
  }, [snappedFull]);

  const onTouchEnd = useCallback(() => {
    if (!tracking.current) return;
    tracking.current = false;
    fromGripper.current = false;
    if (!snappedFull && dragY < -SNAP_UP_THRESHOLD) {
      setSnappedFull(true);
      setDragY(0);
    } else if (!snappedFull && dragY > DISMISS_THRESHOLD) {
      setDismissing(true);
      setTimeout(onClose, 200);
    } else if (snappedFull && dragY > SNAP_UP_THRESHOLD) {
      setSnappedFull(false);
      setDragY(0);
    } else {
      setDragY(0);
    }
  }, [dragY, snappedFull, onClose]);

  const isDragging = tracking.current && dragY !== 0;

  const kbMode = keyboardOpen && vvHeight != null;
  const roundCorners = !snappedFull && !kbMode;

  return (
    <div
      class={`fixed inset-0 z-50 flex flex-col justify-end animate-[fadeIn_0.15s_ease-out]`}
      style={kbMode ? { top: `${vvOffsetTop}px`, height: `${vvHeight}px`, bottom: "auto" } : undefined}
      onClick={onClose}
    >
      <div class={`absolute inset-0 bg-black/50 ${blur ? "backdrop-blur-sm" : ""}`} />
      <div
        ref={sheetRef}
        class={`bottom-sheet relative bg-[var(--bg-primary)] overscroll-contain overflow-y-auto ${!kbMode ? "safe-bottom" : ""} ${roundCorners ? "rounded-t-2xl" : ""} ${dismissing ? "sheet-dismissing" : ""}`}
        style={{
          maxHeight: kbMode
            ? "100%"
            : snappedFull
              ? "100dvh"
              : size === "half"
                ? "50dvh"
                : vvHeight != null
                  ? `${Math.min(vvHeight * 0.85, vvHeight)}px`
                  : "85dvh",
          transform: dragY !== 0 ? `translateY(${dragY > 0 ? dragY : dragY * 0.5}px)` : undefined,
          transition: isDragging ? "none" : "transform 0.3s cubic-bezier(0.25, 1, 0.5, 1), max-height 0.3s cubic-bezier(0.25, 1, 0.5, 1), border-radius 0.2s ease",
        }}
        onClick={(e) => e.stopPropagation()}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        {/* Drag handle */}
        <div ref={gripperRef} class={`sticky top-0 z-10 flex justify-center pt-3 pb-2 bg-[var(--bg-primary)] ${roundCorners ? "rounded-t-2xl" : ""}`}>
          <div class="w-10 h-1 rounded-full bg-[var(--border-color)]" />
        </div>
        {children}
      </div>
    </div>
  );
}
