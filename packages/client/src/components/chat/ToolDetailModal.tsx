import { Check, Circle, Copy, SquareTerminal, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Modal } from "../sidebar/Modal.js";
import { CodeBlock } from "./CodeBlock.js";
import { Chip } from "../ui/Chip.js";
import { Button } from "../ui/Button.js";
import { Spinner } from "../ui/Spinner.js";
import { cn } from "../../lib/cn.js";

export type ToolDetailState = "running" | "ok" | "failed" | "stopped";

function CopyAction({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      onClick={() => void navigator.clipboard?.writeText(text).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1_200);
      })}
      leftIcon={copied ? <Check className="text-success" /> : <Copy />}
    >
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

/** Reusable request/response inspector shared by rich tool presentations. */
export function ToolDetailModal({
  open,
  onClose,
  title,
  description,
  icon = <SquareTerminal />,
  state,
  duration,
  request,
  requestLabel = "Sent",
  response,
  responseLabel = "Received",
  language,
  responseBody,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  icon?: ReactNode;
  state: ToolDetailState;
  duration?: string | null;
  request: string;
  requestLabel?: string;
  response: string;
  responseLabel?: string;
  language?: string;
  responseBody?: ReactNode;
}) {
  const tone = state === "failed" ? "danger" : state === "running" ? "accent" : state === "ok" ? "success" : "muted";
  const stateIcon = state === "running" ? <Spinner size={9} /> : state === "failed" ? <X /> : state === "stopped" ? <Circle /> : <Check />;
  return (
    <Modal
      open={open}
      onClose={onClose}
      width={760}
      icon={icon}
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{title}</span>
          <Chip tone={tone} icon={stateIcon}>{state}</Chip>
          {duration && <span className="cm-mono !text-2xs font-normal text-faint">{duration}</span>}
        </span>
      }
      description={description}
    >
      <div className="space-y-4">
        <section>
          <div className="mb-1.5 flex items-center gap-2">
            <h3 className="text-2xs font-semibold uppercase tracking-[0.08em] text-faint">{requestLabel}</h3>
            <span className="ml-auto"><CopyAction text={request} /></span>
          </div>
          {language ? (
            <CodeBlock code={request} language={language} className="!my-0" />
          ) : (
            <pre className="cm-scroll max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-inset px-3 py-2.5 cm-mono !text-xs text-secondary">{request}</pre>
          )}
        </section>
        <section>
          <div className="mb-1.5 flex items-center gap-2">
            <h3 className="text-2xs font-semibold uppercase tracking-[0.08em] text-faint">{responseLabel}</h3>
            <span className="ml-auto"><CopyAction text={response} /></span>
          </div>
          <div className={cn(
            "cm-scroll max-h-[42vh] overflow-auto rounded-md border px-3 py-2.5",
            state === "failed" ? "border-danger/30 bg-danger-ghost/30" : "border-line bg-inset",
          )}>
            {responseBody ?? (
              <pre className="whitespace-pre-wrap break-words cm-mono !text-xs leading-relaxed text-secondary">{response || "No output"}</pre>
            )}
          </div>
        </section>
      </div>
    </Modal>
  );
}
