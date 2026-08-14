import type { ReactNode } from "react";
import {
  Map as MapIcon,
  Zap,
  Pencil,
  Circle,
  SlidersHorizontal,
  BellOff,
  ShieldOff,
  Check,
  ChevronsUpDown,
} from "lucide-react";
import type { ModeConfig } from "@dispatch/shared";
import { Popover, MenuItem } from "../ui/Popover.js";
import { Tooltip } from "../ui/Tooltip.js";
import { cn } from "../../lib/cn.js";
import { useLayoutMode } from "../../stores/layout.js";

/**
 * Mode and permission posture, as ONE control.
 *
 * They were a segmented Plan/Auto/Edit strip plus a separate posture menu, and
 * they always wrote the same field: `chat.modeId` is one string, resolved
 * server-side through `ModeConfig.permissionMode` or the broker's builtin map.
 * Two widgets over one value could show a state the value cannot have — pick
 * "bypass" and the segmented control matched none of its three segments, so all
 * three rendered unselected and the row claimed no mode was set at all.
 *
 * One trigger, one menu, two labelled sections. Flat rather than a submenu
 * because the whole list is about six rows, and `Popover` cannot nest (a child
 * portals to `document.body`, which the parent's outside-click test doesn't
 * recognise as inside — see ui/Popover). The cost is that Plan/Auto/Edit is now
 * two taps instead of one; the benefit is ~130px back in a row that had none,
 * and a control that can state what it's set to.
 */

/**
 * The canonical modes — everything else is a posture.
 *
 * `default` is in here because it is what `POST /api/chats` stamps on every new
 * chat. Left out, a brand-new chat fell through every branch below: `isPosture`
 * was true so the trigger wore the accent tint that is supposed to mean "you
 * have left the rails", `modeLabel` bottomed out at the raw id and rendered a
 * lowercase "default", and it appeared in NEITHER menu section — so switching
 * away from it was a one-way door. It is a real mode the broker understands
 * (`BUILTIN_MODE_PERMISSION`), not the absence of one.
 */
export const PRIMARY_MODE_IDS = ["default", "plan", "auto", "edit"];

const PRIMARY_MODE_LABEL: Record<string, string> = {
  default: "Default",
  plan: "Plan",
  auto: "Auto",
  edit: "Edit",
};

const MODE_ICONS: Record<string, ReactNode> = {
  default: <Circle />,
  plan: <MapIcon />,
  auto: <Zap />,
  edit: <Pencil />,
};

/**
 * Built-in permission postures the SessionBroker understands via its mode-id
 * fallback map even without a stored ModeConfig.
 */
const BUILTIN_POSTURES: { id: string; name: string; icon: ReactNode; hint: string }[] = [
  { id: "dontAsk", name: "Don't ask", icon: <BellOff />, hint: "no prompts" },
  { id: "bypass", name: "Bypass", icon: <ShieldOff />, hint: "yolo" },
];

/**
 * What the active mode is called. Exported because the composer's compaction
 * measurement has to re-run when this string changes — the label moves the
 * row's natural width without moving its box, so no ResizeObserver fires.
 */
export function modeLabel(modes: ModeConfig[], modeId: string): string {
  return (
    modes.find((m) => m.id === modeId)?.name ??
    PRIMARY_MODE_LABEL[modeId] ??
    BUILTIN_POSTURES.find((b) => b.id === modeId)?.name ??
    modeId
  );
}

export interface ModeControlProps {
  modes: ModeConfig[];
  /** The chat's `modeId` — a primary mode or a posture, they share the field. */
  value: string;
  onChange: (modeId: string) => void;
  /** Icon-only trigger (the toolbar's auto-compact state); the label moves into the tooltip. */
  compact?: boolean;
}

export function ModeControl({ modes, value, onChange, compact = false }: ModeControlProps) {
  // Phone width never goes icon-only here: `Tooltip` is hover/focus, so on touch
  // a bare icon has nothing that can tell you which mode you're in.
  const sm = useLayoutMode() === "sm";
  const iconOnly = compact && !sm;

  const postures: { id: string; name: string; icon: ReactNode; hint: string }[] = [
    ...modes
      .filter((m) => !PRIMARY_MODE_IDS.includes(m.id))
      .map((m) => ({
        id: m.id,
        name: m.name,
        icon: <SlidersHorizontal /> as ReactNode,
        hint: m.permissionMode,
      })),
    ...BUILTIN_POSTURES.filter((b) => !modes.some((m) => m.id === b.id)),
  ];

  const isPosture = !PRIMARY_MODE_IDS.includes(value);
  const label = modeLabel(modes, value);
  const icon = isPosture
    ? (postures.find((p) => p.id === value)?.icon ?? <SlidersHorizontal />)
    : (MODE_ICONS[value] ?? <SlidersHorizontal />);

  return (
    <Popover
      align="start"
      width={sm ? 240 : 220}
      className="p-1"
      trigger={({ open, toggle }) => {
        const btn = (
          <button
            onClick={toggle}
            aria-expanded={open}
            aria-label={`Mode — ${label}`}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border text-sm font-medium " +
                "transition-colors [&_svg]:size-3.5",
              sm ? "h-8" : "h-6",
              iconOnly ? "justify-center px-1.5" : "px-2",
              // The accent is the "you are off the rails" signal the standalone
              // posture button carried; losing it would make bypass look normal.
              isPosture
                ? "border-accent-line bg-accent-ghost text-accent-hi"
                : "border-line bg-panel-2 text-secondary hover:border-line-strong hover:text-primary",
              open && !isPosture && "border-line-strong text-primary",
            )}
          >
            {icon}
            {!iconOnly && (
              <>
                {/* Tighter at phone width so a renamed mode can't grow the row
                    into the Send button on a 320px screen. */}
                <span className={cn("truncate", sm ? "max-w-16" : "max-w-[84px]")}>{label}</span>
                <ChevronsUpDown className="text-faint" />
              </>
            )}
          </button>
        );
        return iconOnly ? <Tooltip label={`Mode — ${label}`}>{btn}</Tooltip> : btn;
      }}
    >
      {(close) => {
        const row = (o: { id: string; name: string; icon: ReactNode; hint?: string }) => (
          <MenuItem
            key={o.id}
            icon={o.icon}
            hint={o.hint}
            dense={!sm}
            active={o.id === value}
            onClick={() => {
              onChange(o.id);
              close();
            }}
          >
            <span className="flex items-center gap-2">
              {o.name}
              {o.id === value && <Check className="size-3 text-accent" />}
            </span>
          </MenuItem>
        );
        return (
          <div className="flex flex-col">
            <div className="px-2 py-1 text-2xs uppercase tracking-wide text-faint">Mode</div>
            {PRIMARY_MODE_IDS.map((id) =>
              row({
                id,
                name: modes.find((m) => m.id === id)?.name ?? PRIMARY_MODE_LABEL[id]!,
                icon: MODE_ICONS[id],
              }),
            )}
            {postures.length > 0 && (
              <>
                <div className="my-1 h-px bg-line" />
                <div className="px-2 py-1 text-2xs uppercase tracking-wide text-faint">
                  Permission posture
                </div>
                {postures.map(row)}
              </>
            )}
          </div>
        );
      }}
    </Popover>
  );
}
