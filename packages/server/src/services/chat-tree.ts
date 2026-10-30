/**
 * A chat's FAMILY — who spawned it, what it spawned, and which reviewer chats
 * were pointed at its pull requests — as `chat_tree` and `chat_state` report it.
 *
 * The edges are exactly the sidebar's (see chat-nesting.ts, whose two edge
 * readers this reuses): a spawned chat names its parent in `parentChatId` (or,
 * for chats older than that field, in its purpose sentence); a reviewer joins
 * THROUGH the pull request, `reviewOf` → the chat that opened it. A connector
 * asking "what did LmKK… spawn?" gets the rows the human sees nested, not a
 * reconstruction that disagrees with the screen.
 *
 * Same-project only, for the sidebar's reason: it builds its tree from one
 * project's chats, so a cross-project edge draws as a root there and is
 * treated as one here. That also keeps a project-restricted integration token
 * inside its allowlist without a second filter — every node shares the
 * starting chat's project.
 */
import type { Chat, PrRecord } from "@dispatch/shared";
import { formatLocalTime, prRecordKey } from "@dispatch/shared";
import { reviewTargetKey, spawnParentId } from "./chat-nesting.js";

/** How a node hangs off its parent. */
export type ChatRelation = "spawned" | "reviewer";

export interface ChatTreeNode {
  id: string;
  title: string;
  status?: string;
  /** A permission prompt or question is waiting on the human. */
  blockedOnHuman?: boolean;
  archived?: boolean;
  /** How THIS chat hangs off its parent (absent on a root). */
  relation?: ChatRelation;
  /** For a reviewer: the PR it reviews, `owner/repo#n`. */
  reviewOf?: string;
  updatedAt: number;
  updatedAtLocal: string;
  /** Its own children, down to the requested depth. */
  children?: ChatTreeNode[];
}

export interface ChatTree {
  /** Root first, ending with the requested chat's parent. Empty for a root. */
  ancestors: ChatTreeNode[];
  /** The requested chat, with its subtree under `children`. */
  chat: ChatTreeNode;
}

/** Direct family, for `chat_state`. */
export interface ChatFamily {
  parent?: { id: string; title: string; relation: ChatRelation };
  children: { id: string; title: string; relation: ChatRelation; status?: string }[];
}

export interface ChatTreeDeps {
  getChat(chatId: string): Promise<Chat | null>;
  listChats(projectId: string): Promise<Chat[]>;
  /** One registry row by key — never a table scan; `chat_state` calls this path. */
  getPrRecord(key: string): Promise<PrRecord | null>;
}

/** Deeper than anything the sidebar draws; bounds a corrupt (cyclic) chain. */
const WALK_LIMIT = 16;

/** One project's chats indexed by both edges, built once per call. */
class Family {
  private readonly byId: Map<string, Chat>;
  private readonly kids = new Map<string, { chat: Chat; relation: ChatRelation }[]>();

  constructor(
    chats: readonly Chat[],
    private readonly prAuthor: ReadonlyMap<string, string>,
  ) {
    this.byId = new Map(chats.map((c) => [c.id, c]));
    for (const c of chats) {
      const edge = this.parentOf(c);
      if (!edge) continue;
      const list = this.kids.get(edge.id) ?? [];
      list.push({ chat: c, relation: edge.relation });
      this.kids.set(edge.id, list);
    }
    for (const list of this.kids.values()) list.sort((a, b) => a.chat.createdAt - b.chat.createdAt);
  }

  get(id: string): Chat | undefined {
    return this.byId.get(id);
  }

  /** The parent edge, when the parent is in this project. */
  parentOf(c: Chat): { id: string; relation: ChatRelation } | null {
    const key = reviewTargetKey(c);
    const id = key ? this.prAuthor.get(key) : spawnParentId(c);
    if (!id || id === c.id || !this.byId.has(id)) return null;
    return { id, relation: key ? "reviewer" : "spawned" };
  }

  childrenOf(id: string): { chat: Chat; relation: ChatRelation }[] {
    return this.kids.get(id) ?? [];
  }
}

function node(c: Chat, relation?: ChatRelation): ChatTreeNode {
  const updatedAt = c.updatedAt ?? c.createdAt;
  const review = relation === "reviewer" ? reviewTargetKey(c) : null;
  return {
    id: c.id,
    title: c.title,
    ...(c.status ? { status: c.status } : {}),
    ...(c.status === "awaiting-input" ? { blockedOnHuman: true } : {}),
    ...(c.archived ? { archived: true } : {}),
    ...(relation ? { relation } : {}),
    ...(review ? { reviewOf: review } : {}),
    updatedAt,
    updatedAtLocal: formatLocalTime(updatedAt),
  };
}

async function familyFor(chat: Chat, deps: ChatTreeDeps): Promise<Family> {
  const listed = await deps.listChats(chat.projectId).catch(() => [] as Chat[]);
  const chats = listed.some((c) => c.id === chat.id) ? listed : [...listed, chat];
  // Who opened each PR a reviewer points at. The project's own refs answer
  // almost every case; only a reviewer key no ref names (a PR the registry
  // attributed by branch) costs an indexed registry read — never a scan of
  // the whole table, which outlives its PRs and only grows.
  const prAuthor = new Map<string, string>();
  for (const c of chats) for (const ref of c.prs ?? []) if (ref.repo) prAuthor.set(prRecordKey(ref.repo, ref.number), c.id);
  const unresolved = new Set<string>();
  for (const c of chats) {
    const key = reviewTargetKey(c);
    if (key && !prAuthor.has(key)) unresolved.add(key);
  }
  await Promise.all(
    [...unresolved].map(async (key) => {
      const row = await deps.getPrRecord(key).catch(() => null);
      if (row?.chatId) prAuthor.set(key, row.chatId);
    }),
  );
  return new Family(chats, prAuthor);
}

/** The chat's ancestors and its subtree to `depth` levels (default 3). Null for an unknown chat. */
export async function chatTree(chatId: string, deps: ChatTreeDeps, depth = 3): Promise<ChatTree | null> {
  const chat = await deps.getChat(chatId);
  if (!chat) return null;
  const fam = await familyFor(chat, deps);

  const ancestors: ChatTreeNode[] = [];
  const seen = new Set([chat.id]);
  let edge = fam.parentOf(chat);
  const relationToChild = edge?.relation;
  while (edge && !seen.has(edge.id) && ancestors.length < WALK_LIMIT) {
    seen.add(edge.id);
    const parent = fam.get(edge.id)!;
    const next = fam.parentOf(parent);
    ancestors.unshift(node(parent, next?.relation));
    edge = next;
  }

  // Ancestors are already listed: on a corrupt (cyclic) chain they would
  // otherwise come back round as descendants and print twice.
  const visited = new Set<string>([chat.id, ...ancestors.map((a) => a.id)]);
  const grow = (c: Chat, relation: ChatRelation | undefined, level: number): ChatTreeNode => {
    const n = node(c, relation);
    if (level >= depth) return n;
    const kids = fam
      .childrenOf(c.id)
      .filter((k) => !visited.has(k.chat.id))
      .map((k) => {
        visited.add(k.chat.id);
        return grow(k.chat, k.relation, level + 1);
      });
    return kids.length ? { ...n, children: kids } : n;
  };
  return { ancestors, chat: grow(chat, relationToChild, 0) };
}

/** Direct parent and children only — the cheap read `chat_state` makes. */
export async function chatFamily(chat: Chat, deps: ChatTreeDeps): Promise<ChatFamily> {
  const fam = await familyFor(chat, deps);
  const up = fam.parentOf(chat);
  const parent = up ? fam.get(up.id) : undefined;
  return {
    ...(up && parent ? { parent: { id: parent.id, title: parent.title, relation: up.relation } } : {}),
    children: fam.childrenOf(chat.id).map((k) => ({
      id: k.chat.id,
      title: k.chat.title,
      relation: k.relation,
      ...(k.chat.status ? { status: k.chat.status } : {}),
    })),
  };
}

/** The tree as indented text — what `chat_tree` shows before its JSON. */
export function renderChatTree(tree: ChatTree): string {
  const line = (n: ChatTreeNode, indent: string, mark: string): string =>
    `${indent}${mark}${n.id} "${n.title}"` +
    [
      n.relation === "reviewer" ? ` [reviewer${n.reviewOf ? ` of ${n.reviewOf}` : ""}]` : "",
      n.status ? ` · ${n.status}` : "",
      n.blockedOnHuman ? " · ⏸ waiting on the human" : "",
      n.archived ? " · archived" : "",
      ` · ${n.updatedAtLocal}`,
    ].join("");
  const out: string[] = [];
  tree.ancestors.forEach((a, i) => out.push(line(a, "  ".repeat(i), i ? "└ " : "")));
  const base = tree.ancestors.length;
  const walk = (n: ChatTreeNode, level: number, self: boolean): void => {
    out.push(line(n, "  ".repeat(level), (level ? "└ " : "") + (self ? "▶ " : "")));
    for (const c of n.children ?? []) walk(c, level + 1, false);
  };
  walk(tree.chat, base, true);
  return out.join("\n");
}
