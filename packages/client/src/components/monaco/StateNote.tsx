/**
 * The centred icon + title + detail placeholder a file pane shows instead of
 * content — binary, too large, deleted, failed to load. The code viewer and the
 * git diff pane each carried an identical private copy, so a tweak to one
 * (spacing, the detail's wrapping) silently left the other behind.
 */
export function StateNote({
  icon,
  title,
  detail,
}: {
  icon: React.ReactNode;
  title: string;
  detail?: string;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <span className="mb-2 flex size-9 items-center justify-center rounded-md border border-line bg-panel-2 [&_svg]:size-4">
        {icon}
      </span>
      <p className="text-base font-medium text-secondary">{title}</p>
      {detail && (
        <p className="mt-0.5 max-w-md cm-mono !text-xs text-faint break-words">{detail}</p>
      )}
    </div>
  );
}
