import { useEffect, useRef } from "preact/hooks";
import { toasts, type Toast } from "../state";

const TOAST_DURATION = 3000;

const icons: Record<Toast["type"], string> = {
  success:
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M13.5 4.5L6.5 11.5L2.5 7.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  error:
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M12 4L4 12M4 4l8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  info: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5"/><path d="M8 7v4M8 5.5v0" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
};

const accentColors: Record<Toast["type"], string> = {
  success: "var(--toast-success)",
  error: "var(--toast-error)",
  info: "var(--accent)",
};

function ToastItem({ toast }: { toast: Toast }) {
  const ref = useRef<HTMLDivElement>(null);
  const removing = useRef(false);

  const dismiss = () => {
    if (removing.current) return;
    removing.current = true;
    ref.current?.classList.add("toast-exit");
    setTimeout(() => {
      toasts.value = toasts.value.filter((t) => t.id !== toast.id);
    }, 250);
  };

  useEffect(() => {
    const timer = setTimeout(dismiss, TOAST_DURATION);
    return () => clearTimeout(timer);
  }, []);

  const accent = accentColors[toast.type];

  return (
    <div
      ref={ref}
      role="status"
      onClick={dismiss}
      class="toast-item"
      style={{ "--toast-accent": accent } as any}
    >
      <span
        class="toast-icon"
        dangerouslySetInnerHTML={{ __html: icons[toast.type] }}
      />
      <span class="toast-msg">{toast.message}</span>
      <div class="toast-progress" />
    </div>
  );
}

export function ToastContainer() {
  if (toasts.value.length === 0) return null;

  return (
    <div class="toast-container">
      {toasts.value.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  );
}
