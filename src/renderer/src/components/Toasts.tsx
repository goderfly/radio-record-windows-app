import { CheckCircle2, AlertTriangle, Info } from "lucide-react";
import { useStore } from "../state/store";

export function Toasts(): JSX.Element {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);

  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast--${toast.tone}`} role="status">
          <span className="toast__icon">
            {toast.tone === "error" ? (
              <AlertTriangle size={15} />
            ) : toast.tone === "success" ? (
              <CheckCircle2 size={15} />
            ) : (
              <Info size={15} />
            )}
          </span>
          <span>{toast.message}</span>
          <button
            className="icon-btn icon-btn--sm"
            onClick={() => dismiss(toast.id)}
            aria-label="Закрыть уведомление"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
