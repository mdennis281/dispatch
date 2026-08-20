/**
 * Sidebar dialog kit — a portal-mounted modal shell + a few dense form controls,
 * all built from the shared Linear/Zed tokens (same surface/overlay/rise as the
 * Popover) so orchestration dialogs match the design system without forking it.
 */
import {
  useEffect,
  type ReactNode,
  type InputHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import { X, AlertCircle } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { useDialogLayer } from "../../lib/layers.js";
import { IconButton } from "../ui/IconButton.js";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  icon?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}

/** A centered, backdrop-dimmed dialog. Escape / backdrop-click / ✕ all close. */
export function Modal({
  open,
  onClose,
  title,
  icon,
  description,
  children,
  footer,
  width = 480,
}: ModalProps) {
  // Stacks above whatever is already open — a dialog opened FROM a dialog (the
  // task run settings inside project config, say) is always on top. See
  // lib/layers.
  const z = useDialogLayer(open);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      style={{ zIndex: z }}
      className={
        // Top-anchored, so the 24px gutter is all that stands between the title
        // row and the status bar on a phone — `cm-safe-pad` makes each side the
        // larger of the two. The `sm` offset gets the same treatment for the
        // short viewport where 9vh is the smaller number.
        "fixed inset-0 flex items-start justify-center overflow-y-auto " +
        "cm-safe-pad [--cm-gutter:1.5rem] sm:pt-[max(9vh,var(--cm-safe-top),var(--cm-titlebar-h))]"
      }
    >
      <div
        className="fixed inset-0 bg-scrim backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        className={
          "relative z-10 w-full rounded-lg border border-line-strong bg-overlay/98 " +
          "backdrop-blur-md shadow-[var(--shadow-pop)] cm-anim-rise"
        }
        style={{ maxWidth: width }}
      >
        <header className="flex items-center gap-2.5 px-4 py-3 cm-hairline-b">
          {icon && (
            <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-accent-ghost text-accent ring-1 ring-accent-line [&_svg]:size-3.5">
              {icon}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-semibold text-primary">{title}</h2>
            {description && (
              <p className="mt-px truncate text-xs text-muted">{description}</p>
            )}
          </div>
          <IconButton tip="Close" onClick={onClose}>
            <X />
          </IconButton>
        </header>

        <div className="cm-scroll max-h-[68vh] overflow-y-auto px-4 py-4">{children}</div>

        {footer && (
          <footer className="flex items-center gap-2 px-4 py-3 cm-hairline-t">{footer}</footer>
        )}
      </div>
    </div>,
    document.body,
  );
}

/* --------------------------------------------------------------- form kit */

const controlCls =
  "w-full rounded-md border border-line bg-inset px-2.5 py-[7px] text-base text-primary " +
  "placeholder:text-faint outline-none transition-colors hover:border-line-strong focus:border-accent-line";

export function Field({
  label,
  hint,
  required,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  required?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("block", className)}>
      <span className="mb-1 flex items-baseline gap-1.5">
        <span className="text-xs font-medium text-secondary">{label}</span>
        {required && <span className="text-xs text-danger">*</span>}
        {hint && <span className="ml-auto text-2xs text-faint">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

export function TextInput({
  mono,
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }) {
  return <input className={cn(controlCls, mono && "cm-mono !text-xs", className)} {...rest} />;
}

export function TextArea({
  className,
  rows = 4,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea rows={rows} className={cn(controlCls, "resize-none leading-relaxed", className)} {...rest} />
  );
}

/** A short inline error strip for a failed REST call. */
export function InlineError({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <div className="flex items-start gap-1.5 rounded-md border border-danger/30 bg-danger-ghost px-2.5 py-1.5 text-xs text-danger [&_svg]:mt-px [&_svg]:size-3.5 [&_svg]:shrink-0">
      <AlertCircle />
      <span className="min-w-0">{message}</span>
    </div>
  );
}
