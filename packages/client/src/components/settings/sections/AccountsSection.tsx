import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, CircleDashed, FolderX, KeyRound, Plus, Save, Trash2, Undo2 } from "lucide-react";
import {
  PROVIDER_IDS,
  SubscriptionListSchema,
  providerFor,
  type HarnessKind,
  type Subscription,
  type SubscriptionStatus,
} from "@dispatch/shared";
import { InlineError, TextInput } from "../../sidebar/Modal.js";
import { Button } from "../../ui/Button.js";
import { IconButton } from "../../ui/IconButton.js";
import { Select } from "../../ui/Select.js";
import { SectionLabel } from "../../ui/Panel.js";
import { Spinner } from "../../ui/Spinner.js";
import { useSubscriptions } from "../../../stores/subscriptions.js";

/**
 * The login accounts — several per provider.
 *
 * Saved through its OWN endpoint, immediately, rather than through the settings
 * draft: `PUT /api/settings` deliberately preserves the list (a draft loaded
 * before an account was added must not delete it), so it is not a field that
 * draft could write even if it tried. The section therefore carries its own
 * Save, the way Authentication acts on its own.
 *
 * Nothing here ever holds a credential. An account is a directory; the login in
 * it is made by the provider's CLI, and all this pane can say about it is
 * whether the login FILE exists.
 */
export function AccountsSection() {
  const statuses = useSubscriptions((s) => s.list);
  const loaded = useSubscriptions((s) => s.loaded);
  const load = useSubscriptions((s) => s.load);
  const save = useSubscriptions((s) => s.save);

  // The stored list is exactly the non-implicit statuses — the implicit ones are
  // the server filling in providers nobody listed.
  const stored = useMemo<Subscription[]>(
    () =>
      statuses
        .filter((s) => !s.implicit)
        .map(({ id, name, provider, configDir }) => ({ id, name, provider, configDir })),
    [statuses],
  );
  const [rows, setRows] = useState<Subscription[]>(stored);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A fresh read on every visit: login presence changes when someone runs a
  // login in a terminal, which nothing would otherwise tell this pane about.
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => setRows(stored), [stored]);

  const dirty = JSON.stringify(rows) !== JSON.stringify(stored);
  const statusOf = (id: string): SubscriptionStatus | undefined =>
    dirty ? undefined : statuses.find((s) => s.id === id);
  const implicit = statuses.filter((s) => s.implicit);

  const patchRow = (i: number, p: Partial<Subscription>) =>
    setRows((cur) => cur.map((r, j) => (j === i ? { ...r, ...p } : r)));

  const add = (provider: HarnessKind) =>
    setRows((cur) => {
      // The id is what chats pin, so it is minted once and never follows a
      // rename — `claude2` stays `claude2` whatever it is called later.
      const taken = new Set([...cur.map((r) => r.id), ...statuses.map((s) => s.id)]);
      let n = cur.filter((r) => r.provider === provider).length + 1;
      while (taken.has(`${provider}${n}`)) n += 1;
      const id = `${provider}${n}`;
      return [...cur, { id, name: id, provider, configDir: "" }];
    });

  const submit = async () => {
    // A blank dir means "the provider's default", which the schema spells as absent.
    const list = rows.map((r) => ({ ...r, configDir: r.configDir?.trim() || undefined }));
    const parsed = SubscriptionListSchema.safeParse(list);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid account list");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await save(parsed.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!loaded) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
        <Spinner size={14} /> Loading accounts…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <SectionLabel className="mb-1.5 px-0">Accounts</SectionLabel>
        {rows.length === 0 ? (
          <p className="text-2xs leading-snug text-faint">
            No accounts listed — every provider runs on its default login. Add one to run chats
            under a second login of the same provider.
          </p>
        ) : (
          <div className="space-y-2">
            {rows.map((row, i) => {
              const status = statusOf(row.id);
              const account = providerFor(row.provider).account;
              return (
                <div key={row.id} className="rounded-md border border-line bg-inset/40 p-2.5">
                  <div className="flex items-center gap-2">
                    <KeyRound className="size-3.5 shrink-0 text-muted" />
                    <TextInput
                      aria-label="Account name"
                      value={row.name}
                      onChange={(e) => patchRow(i, { name: e.target.value })}
                      className="!h-7 min-w-0 flex-1"
                    />
                    <span className="cm-mono shrink-0 text-2xs text-faint" title="Id chats pin">
                      {row.id}
                    </span>
                    <Select<HarnessKind>
                      width={140}
                      value={row.provider}
                      onChange={(provider) => patchRow(i, { provider })}
                      options={PROVIDER_IDS.map((id) => ({ value: id, label: providerFor(id).label }))}
                    />
                    <IconButton
                      tip="Remove — chats on it fall back to the provider's default account"
                      onClick={() => setRows((cur) => cur.filter((_, j) => j !== i))}
                    >
                      <Trash2 />
                    </IconButton>
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <TextInput
                      mono
                      aria-label="Config directory"
                      placeholder={`default (~/${account.defaultConfigDir})`}
                      value={row.configDir ?? ""}
                      onChange={(e) => patchRow(i, { configDir: e.target.value })}
                      className="!h-7 min-w-0 flex-1"
                    />
                    <LoginBadge status={status} />
                  </div>
                  {status && !status.loggedIn && (
                    <p className="mt-1.5 text-2xs leading-snug text-faint">
                      Log in with the provider&rsquo;s own CLI, pointed at this directory:{" "}
                      <span className="cm-mono">
                        {account.configDirEnv}={status.resolvedConfigDir}
                      </span>
                      . Dispatch never sees the token.
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="mt-2 flex flex-wrap items-center gap-2">
          {PROVIDER_IDS.map((provider) => (
            <Button key={provider} variant="ghost" leftIcon={<Plus />} onClick={() => add(provider)}>
              {providerFor(provider).shortLabel} account
            </Button>
          ))}
          {dirty && (
            <div className="ml-auto flex items-center gap-2">
              <Button
                variant="ghost"
                leftIcon={<Undo2 />}
                disabled={busy}
                onClick={() => {
                  setRows(stored);
                  setError(null);
                }}
              >
                Discard
              </Button>
              <Button
                variant="primary"
                leftIcon={busy ? <Spinner size={12} /> : <Save />}
                disabled={busy}
                onClick={() => void submit()}
              >
                Save accounts
              </Button>
            </div>
          )}
        </div>
        {error && (
          <div className="mt-2">
            <InlineError message={error} />
          </div>
        )}
      </div>

      {implicit.length > 0 && (
        <div className="border-t border-line-soft pt-3">
          <SectionLabel className="mb-1.5 px-0">Default logins</SectionLabel>
          <p className="mb-2 text-2xs leading-snug text-faint">
            Providers with no account listed run on their default login directory.
          </p>
          <div className="space-y-1">
            {implicit.map((s) => (
              <div key={s.id} className="flex items-center gap-2 text-xs text-secondary">
                <span className="w-24 shrink-0">{providerFor(s.provider).label}</span>
                <span className="cm-mono min-w-0 flex-1 truncate text-2xs text-faint">
                  {s.resolvedConfigDir}
                </span>
                <LoginBadge status={s} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Whether the directory holds a login — existence of the login file, nothing more. */
function LoginBadge({ status }: { status: SubscriptionStatus | undefined }) {
  const cls = "flex shrink-0 items-center gap-1 text-2xs [&_svg]:size-3";
  if (!status) return <span className={`${cls} text-faint`}>save to check</span>;
  if (!status.dirExists) {
    return (
      <span className={`${cls} text-warn`}>
        <FolderX /> no such directory
      </span>
    );
  }
  return status.loggedIn ? (
    <span className={`${cls} text-success`}>
      <CheckCircle2 /> logged in
    </span>
  ) : (
    <span className={`${cls} text-muted`}>
      <CircleDashed /> not logged in
    </span>
  );
}
