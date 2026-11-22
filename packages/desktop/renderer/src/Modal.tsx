import { useApp } from "./context";
import { useEffect, type ReactNode } from "react";

export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className={`modal${wide ? " modal-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn btn-ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function ReceiptView({ text, logo = true }: { text: string; logo?: boolean }) {
  const { settings } = useApp();
  return (
    <div className="receipt-box">
      {logo && settings.businessLogo && <img className="receipt-logo" src={settings.businessLogo} alt="" />}
      <pre className="receipt">{text}</pre>
    </div>
  );
}

/**
 * What the printer sees: the shop's logo (if it has one) above the receipt text. Hidden on screen, shown when printing.
 */
export function PrintArea({ text, logo = true }: { text: string; logo?: boolean }) {
  const { settings } = useApp();
  return (
    <div id="print-area">
      {logo && settings.businessLogo && <img className="print-logo" src={settings.businessLogo} alt="" />}
      <pre>{text}</pre>
    </div>
  );
}
