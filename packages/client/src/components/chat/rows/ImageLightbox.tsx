import { useEffect } from "react";
import { createPortal } from "react-dom";
import { Download, X } from "lucide-react";
import { IconButton } from "../../ui/IconButton.js";
import { useDialogLayer } from "../../../lib/layers.js";

/**
 * Full-screen viewer for a single chat image — opened by clicking an
 * {@link ImageThumb}. Escape / backdrop-click / ✕ close it; the download button
 * saves the bytes under the image's filename (works for served assets and
 * inline data: URLs alike).
 */
export function ImageLightbox({
  src,
  name,
  dims,
  onClose,
}: {
  src: string;
  name: string;
  dims?: string;
  onClose: () => void;
}) {
  const z = useDialogLayer();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      style={{ zIndex: z }}
      className="fixed inset-0 flex flex-col bg-scrim-strong backdrop-blur-[2px]"
      onClick={onClose}
    >
      <header
        className="flex items-center gap-2 px-4 py-2.5 text-secondary"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="min-w-0 flex-1 truncate text-sm text-secondary">{name}</span>
        {dims && <span className="cm-mono !text-2xs text-faint">{dims}</span>}
        <a
          href={src}
          download={name}
          className="flex size-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-active hover:text-primary [&_svg]:size-4"
          title="Download"
          aria-label="Download image"
        >
          <Download />
        </a>
        <IconButton tip="Close" onClick={onClose}>
          <X />
        </IconButton>
      </header>

      <div className="flex min-h-0 flex-1 items-center justify-center p-4">
        <img
          src={src}
          alt={name}
          onClick={(e) => e.stopPropagation()}
          className="max-h-full max-w-full cursor-default object-contain shadow-[var(--shadow-pop)]"
        />
      </div>
    </div>,
    document.body,
  );
}
