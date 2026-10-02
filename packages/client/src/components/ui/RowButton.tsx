/**
 * A whole row that happens to be clickable.
 *
 * `Button` and `IconButton` are the right primitives for an ACTION: they own
 * their height, padding, radius and variant, which is exactly what makes them
 * wrong here. A navigation row owns none of those — it is a full-width,
 * left-aligned, often multi-line target whose layout IS the content (a title
 * over a path, a glyph beside a status word and an age pinned right). Forcing
 * one into a variant means overriding `h-6`, `justify-center`,
 * `whitespace-nowrap` and the variant's own padding at every call site, and
 * `cn` is plain clsx with no tailwind-merge — so both declarations survive and
 * stylesheet order decides which row height you get.
 *
 * So the answer the primitive kit wants is ONE bare element, wrapped once, in
 * place of the same bare element written out at every row in the app. It lives
 * in `components/ui` for the same reason `Button` does: `rawButtons.test.ts`
 * counts bare `<button>` outside this directory, and a row primitive that is
 * itself a counted bypass teaches the wrong lesson.
 *
 * It deliberately carries almost no styling — `text-left` because a row is
 * text, and the transition so a `hover:bg-*` the caller supplies fades rather
 * than snapping. Everything else is the caller's layout, which is the point.
 */
import type { ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/cn.js";

export function RowButton({
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={cn("text-left transition-colors", className)} {...rest}>
      {children}
    </button>
  );
}
