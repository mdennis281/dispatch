import { useEffect, useMemo, useState } from "react";
import {
  ArrowDownRight,
  CheckCircle2,
  CircleDashed,
  FolderX,
  KeyRound,
  Plus,
  Save,
  Server,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import {
  PROVIDER_IDS,
  SubscriptionListSchema,
  accountLabel,
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
        .map(({ id, name, provider, configDir, host, fallbacks }) => ({
          id,
          name,
          provider,
          configDir,
          host,
          fallbacks,
        })),
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
      return [...cur, { id, name: id, provider, configDir: "", host: "" }];
    });

  const submit = async () => {
    // A blank dir or host means "the provider's default", which the schema
    // spells as absent.
    const live = liveAccountIds(rows, statuses);
    const list = rows.map((r) => {
      // A fallback naming a row deleted in this same edit is dropped here
      // rather than saved and skipped at runtime — the pane should not persist
      // an edge it is about to render as blank.
      const fallbacks = (r.fallbacks ?? []).filter((id) => id !== r.id && live.has(id));
      return {
        ...r,
        configDir: r.configDir?.trim() || undefined,
        host: r.host?.trim() || undefined,
        fallbacks: fallbacks.length > 0 ? fallbacks : undefined,
      };
    });
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
                  {/*
                    An endpoint provider's account is a MACHINE, not a login —
                    goose runs local models, so there is no token, no config dir
                    worth editing and nothing for a login badge to report. What
                    distinguishes two goose accounts is which Ollama serves them,
                    so that is the only field this row offers.
                  */}
                  {account.endpointEnv ? (
                    <div className="mt-2 flex items-center gap-2">
                      <Server className="size-3.5 shrink-0 text-muted" />
                      <TextInput
                        mono
                        aria-label={account.endpointLabel ?? "Endpoint"}
                        placeholder={`default (${account.defaultEndpoint})`}
                        value={row.host ?? ""}
                        onChange={(e) => patchRow(i, { host: e.target.value })}
                        className="!h-7 min-w-0 flex-1"
                      />
                    </div>
                  ) : (
                    <>
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
                    </>
                  )}
                  <FallbackEditor
                    row={row}
                    rows={rows}
                    onChange={(fallbacks) => patchRow(i, { fallbacks })}
                  />
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
          <SectionLabel className="mb-1.5 px-0">Defaults</SectionLabel>
          <p className="mb-2 text-2xs leading-snug text-faint">
            Providers with no account listed run on their default. Add an account for one to give
            it a fallback &mdash; leave its directory blank and it stays the same default login.
          </p>
          <div className="space-y-1">
            {implicit.map((s) => {
              const { account } = providerFor(s.provider);
              return (
                <div key={s.id} className="flex items-center gap-2 text-xs text-secondary">
                  <span className="w-24 shrink-0">{providerFor(s.provider).label}</span>
                  {/*
                    An endpoint provider's default is a HOST, and it has no login
                    to badge. Showing its config dir listed a directory goose
                    does not use on Windows and flagged it "no such directory" in
                    red — a warning about nothing, next to the one fact that
                    actually matters here.
                  */}
                  {account.endpointEnv ? (
                    <span className="cm-mono min-w-0 flex-1 truncate text-2xs text-faint">
                      {account.defaultEndpoint}
                    </span>
                  ) : (
                    <>
                      <span className="cm-mono min-w-0 flex-1 truncate text-2xs text-faint">
                        {s.resolvedConfigDir}
                      </span>
                      <LoginBadge status={s} />
                    </>
                  )}
                </div>
              );
            })}
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

/**
 * Every account id a fallback may legally point at after this save.
 *
 * The IMPLICIT ones count. `rows` holds only the stored list, but a provider
 * nobody listed still has a real account at its default directory, and both
 * `fallbackChain` and the schema accept one as a target. Pruning against the
 * stored rows alone silently deleted such an edge the next time anything else
 * on this pane was saved — the list PUT is a full replace, so an edge the user
 * never touched went with it.
 */
export function liveAccountIds(
  rows: readonly Subscription[],
  statuses: readonly SubscriptionStatus[],
): Set<string> {
  return new Set([
    ...rows.map((r) => r.id),
    ...statuses.filter((s) => s.implicit).map((s) => s.id),
  ]);
}

/**
 * Where a chat goes when THIS account runs out of budget, in order.
 *
 * Ordered rather than a single pick because a limit can be survived more than
 * once: with two accounts exhausted there is still a third to reach for. The
 * list is walked top-down and the first account with budget takes the work.
 *
 * An entry may name another provider. That is legal and sometimes exactly what
 * is wanted (Codex running out should not stop the work when Claude is idle),
 * but it costs the live session — only two accounts of the SAME provider can
 * hand the conversation over natively — so the row says so rather than letting
 * it be discovered mid-task.
 */
function FallbackEditor({
  row,
  rows,
  onChange,
}: {
  row: Subscription;
  rows: readonly Subscription[];
  onChange: (fallbacks: string[] | undefined) => void;
}) {
  const chain = row.fallbacks ?? [];
  // Self is excluded because an account cannot rescue itself, and an id already
  // in the chain because a repeat would just be skipped.
  const eligible = rows.filter((r) => r.id !== row.id && !chain.includes(r.id));
  const nameOf = (id: string) => rows.find((r) => r.id === id);
  const set = (next: string[]) => onChange(next.length > 0 ? next : undefined);
  const crossProvider = chain.some((id) => {
    const target = nameOf(id);
    return target && target.provider !== row.provider;
  });

  return (
    <div className="mt-2 border-t border-line-soft pt-2">
      <div className="flex items-center gap-1.5 text-2xs text-faint">
        <ArrowDownRight className="size-3 shrink-0" />
        <span>Falls back to</span>
      </div>
      {chain.length === 0 ? (
        <p className="mt-1 text-2xs leading-snug text-faint">
          Nothing — a usage limit on this account parks the chat until its window reopens.
        </p>
      ) : (
        <div className="mt-1.5 space-y-1">
          {chain.map((id, k) => {
            const target = nameOf(id);
            return (
              <div key={id} className="flex items-center gap-2">
                <span className="w-4 shrink-0 text-right text-2xs text-faint">{k + 1}.</span>
                <Select<string>
                  width={200}
                  value={id}
                  onChange={(next) => set(chain.map((c, j) => (j === k ? next : c)))}
                  options={[...(target ? [target] : []), ...eligible].map((r) => ({
                    value: r.id,
                    label: `${accountLabel(r)} · ${providerFor(r.provider).shortLabel}`,
                  }))}
                />
                {target && target.provider !== row.provider && (
                  <span className="text-2xs text-warn">hands off context</span>
                )}
                <IconButton
                  tip="Remove this fallback"
                  onClick={() => set(chain.filter((_, j) => j !== k))}
                >
                  <X />
                </IconButton>
              </div>
            );
          })}
        </div>
      )}
      {eligible.length > 0 && (
        <Button
          variant="ghost"
          leftIcon={<Plus />}
          className="mt-1"
          onClick={() => set([...chain, eligible[0]!.id])}
        >
          {chain.length === 0 ? "Add fallback" : "Add another fallback"}
        </Button>
      )}
      {crossProvider && (
        <p className="mt-1 text-2xs leading-snug text-faint">
          A fallback on another provider cannot carry the live session, so the chat continues from a
          transcript handoff instead of its full context.
        </p>
      )}
    </div>
  );
}
