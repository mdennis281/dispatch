/**
 * TEXT MATCHING — the one similarity primitive every Dispatch search uses.
 *
 * Two stores were each growing their own: `chat_find` did a raw lowercase
 * `includes`, and memory recall tokenized and stemmed in private. The raw form
 * is what broke — `chat_find "reload modular seed"` missed a chat titled
 * "Anoxia: Continue without reload — modular seed loading" because the em dash
 * sits inside the span the query names, and a reordered or misspelled query
 * missed it outright. Worse, when it DID match, the exact title came back last
 * of five, under chats that merely quoted it, because hits were all-or-nothing
 * and only recency could order them.
 *
 * So this file is token-based, and deliberately cheap:
 *   - NORMALIZE: NFKD + strip combining marks + lowercase, and EVERY run of
 *     non-letter/non-digit (dashes of every width, colons, underscores, slashes,
 *     dots) becomes one space. "Continue without reload — modular" and
 *     "continue-without-reload_modular" are then the same string.
 *   - SCORE a field in [0,1] by weighted token coverage (exact > stem > prefix >
 *     infix > typo) times a minimal-window proximity factor, with a contiguous
 *     phrase pinned at 1. Linear in the field's token count; edit distance only when the caller
 *     opts in (titles), and then BOUNDED so it is O(len·k), never O(len²).
 *   - PREFILTER a raw line with plain `includes` per token, so a scan over
 *     hundreds of MB still pays JSON.parse + scoring only on candidate lines.
 *
 * It is a SUPERSET of the old substring match by construction: anything whose
 * text contains the query verbatim passes the prefilter and scores at least
 * {@link VERBATIM_FLOOR}, so no search that hit before can miss now.
 */

/* ------------------------------------------------------------ normalization */

/** Lowercase, fold accents, and turn every punctuation run into one space. */
export function normalizeText(text: string): string {
  return String(text ?? "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Split text into normalized word tokens of at least `minLength` chars. */
export function tokenize(text: string, minLength = 2): string[] {
  const norm = normalizeText(text);
  if (!norm) return [];
  return norm.split(" ").filter((t) => t.length >= minLength);
}

/**
 * Fold a token to a crude stem so inflections match: a user asks why the client
 * is "desyncing" while the memory is named `steam-lobby-rejoin-desync`, and a
 * whole-token comparison misses it entirely — which on a real corpus demoted the
 * one exactly-right memory below unrelated ones.
 *
 * Deliberately conservative and NOT linguistically correct. It's applied to both
 * sides of every comparison, so all that matters is that it folds consistently;
 * an over-eager rule would collide unrelated words and invent matches.
 */
export function stem(token: string): string {
  let t = token;
  if (t.length > 5 && t.endsWith("ing")) t = t.slice(0, -3);
  else if (t.length > 4 && t.endsWith("ed")) t = t.slice(0, -2);
  else if (t.length > 4 && t.endsWith("ies")) t = `${t.slice(0, -3)}y`;
  else if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) t = t.slice(0, -1);
  // "running" → "runn" → "run"; harmless when the doubling wasn't inflectional.
  if (t.length > 3 && t[t.length - 1] === t[t.length - 2]) t = t.slice(0, -1);
  return t;
}

/**
 * Function words that carry no retrieval intent. A user turn is a SENTENCE, not
 * a search box ("why is the client desyncing after someone leaves the lobby"),
 * so without this every memory collects a hit for `the`/`is`/`to`/… — on a real
 * ~140-memory store that alone put a uniform floor under EVERY memory's score,
 * which is what let unrelated facts outrank the right one.
 */
export const STOPWORDS: ReadonlySet<string> = new Set([
  "about","after","again","all","also","am","an","and","any","are","as","at","be",
  "because","been","before","being","below","between","both","but","by","can","did",
  "do","does","doing","don","down","during","each","few","for","from","further","had",
  "has","have","having","he","her","here","hers","him","his","how","if","in","into",
  "is","it","its","just","me","more","most","my","no","nor","not","now","of","off",
  "on","once","only","or","other","our","ours","out","over","own","re","same","she",
  "should","so","some","such","than","that","the","their","theirs","them","then",
  "there","these","they","this","those","through","to","too","under","until","up",
  "ve","very","was","we","were","what","when","where","which","while","who","whom",
  "why","will","with","would","you","your","yours",
  // conversational verbs that appear in almost every turn AND every memory body
  "add","added","fix","fixed","get","give","got","let","look","make","made","need",
  "please","see","take","try","use","used","want","work","works",
]);

/**
 * The tokens of a query worth requiring: stopwords removed, deduped. Falls back
 * to every token when the query is ALL stopwords ("how to"), so a deliberate
 * search never silently matches nothing.
 */
export function significantTokens(query: string, minLength = 2): string[] {
  const all = tokenize(query, minLength);
  const kept = all.filter((t) => !STOPWORDS.has(t));
  return [...new Set(kept.length ? kept : all)];
}

/** Jaccard overlap of two token sets — |A∩B| / |A∪B|, in [0,1]. */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Optimal-string-alignment edit distance (Levenshtein + adjacent transposition),
 * BOUNDED: returns `max + 1` as soon as the answer must exceed `max`. The band
 * keeps it O(len·max) — a typo check against every title token stays linear.
 */
export function boundedEditDistance(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const n = b.length;
  let prev2: number[] = [];
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(n + 1).fill(max + 1);
    cur[0] = i;
    let rowMin = cur[0];
    const lo = Math.max(1, i - max);
    const hi = Math.min(n, i + max);
    for (let j = lo; j <= hi; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2]! + 1);
      }
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return Math.min(prev[n]!, max + 1);
}

/* ------------------------------------------------------------------ scoring */

/** Per-token credit by how a query token was found in the text. */
const CREDIT = {
  exact: 1,
  stem: 0.95,
  /** Query token begins a text token: "reload" → "reloading", "auth" → "authz". */
  prefix: 0.85,
  /** Query token inside a text token: "chats" in "findchats" — code-ish text. */
  infix: 0.7,
  typo1: 0.7,
  typo2: 0.55,
} as const;

/** A stopword's share of the coverage, when the query has real words too. */
const STOPWORD_WEIGHT = 0.2;
/** The contiguous normalized phrase, word-aligned. */
const PHRASE_SCORE = 1;
/** The phrase with its LAST word still being typed: "continue without rel". */
const PHRASE_PREFIX_SCORE = 0.97;
/**
 * Ceiling for a match assembled from separate tokens. Without it "where the
 * load time goes" scored "where the REMAINING load time goes" a perfect 1.0
 * too — only stopwords were out of place — and the exact title lost the tie
 * to whichever chat was newer.
 */
const TOKENS_MAX = 0.95;
/**
 * The raw text contains the raw query verbatim — the old substring rule. Pinned
 * high so a search that used to hit still ranks with the best of them even when
 * normalization can't see why (a query that is all punctuation, say).
 */
export const VERBATIM_FLOOR = 0.9;

export interface TextMatch {
  /** Similarity in [0,1], two decimals. */
  score: number;
  /** How it matched — for a caller that wants to explain or threshold by kind. */
  via: "phrase" | "verbatim" | "tokens";
}

export interface CompileOptions {
  /**
   * Allow bounded-edit-distance typo matches. Costly enough that it belongs on
   * short fields only — titles, names — never on a full transcript row.
   */
  typos?: boolean;
  /**
   * Every significant query token must match, or the field doesn't. The rule
   * for long fields: one shared word in a 20 KB assistant turn is noise. The
   * raw-line prefilter alone can't enforce it — it tests substrings, so a "1"
   * in a timestamp satisfied the `1` of "exit code 1".
   */
  requireAll?: boolean;
  /** Minimum token length (default 2). A lone digit is always kept. */
  minLength?: number;
}

/** A query compiled once and run against many fields. */
export interface TextMatcher {
  readonly raw: string;
  /** Normalized query (the phrase form). */
  readonly phrase: string;
  /** Every query token, in order, deduped. */
  readonly tokens: readonly string[];
  /** Lowercase substrings a raw line must ALL contain to be worth parsing. */
  readonly needles: readonly string[];
  /**
   * Cheap gate for a RAW (e.g. JSON-encoded) line: the verbatim query, or EVERY
   * significant token (as its stem's prefix). A superset of what
   * {@link score} accepts under `requireAll`, so a line failing it is safe to
   * skip without parsing.
   */
  prefilter(rawLine: string): boolean;
  /** Score one field, or null when it doesn't match. */
  score(text: string): TextMatch | null;
  /** Lowercase strings to centre a snippet on, best first. */
  readonly focus: readonly string[];
}

/**
 * The substring every inflection {@link stem} folds together must contain: the
 * token's shared prefix with its stem, minus a trailing `y`. Without dropping
 * the `y`, "query" demanded `query` of a line that only said "queries" — the
 * prefilter rejected a row the scorer would have credited as a stem match.
 */
function stemNeedle(token: string): string {
  const s = stem(token).replace(/y$/, "");
  let i = 0;
  while (i < s.length && i < token.length && s[i] === token[i]) i++;
  return token.slice(0, i);
}

/** Typo budget for a token of this length — none below 4 chars (too ambiguous). */
function typoBudget(len: number): number {
  return len >= 8 ? 2 : len >= 4 ? 1 : 0;
}

/**
 * Words of slack allowed per matched token before proximity starts to bite
 * hard. At 4, two query words ~40 words apart (a paragraph) still clear the 0.5
 * row threshold; spread across a 3000-word turn they score 0.4 and do not.
 */
const PROXIMITY_SLACK = 4;
/** Share of the score proximity controls. Below 0.5 a scattered row can never pass. */
const PROXIMITY_SHARE = 0.6;

/**
 * Query tokens: the normalized words of at least `minLength` chars — plus any
 * lone DIGIT. Dropping 1-char tokens wholesale turned "exit code 1" into "exit
 * code", which then scored 0.95 on "exit code 0": in an error search the digit
 * is often the entire question.
 */
function queryTokenList(raw: string, minLength: number): string[] {
  return [...new Set(tokenize(raw, 1).filter((t) => t.length >= minLength || /^\d$/.test(t)))];
}

/**
 * Compile a query for repeated scoring.
 *
 * Score of a field, when it isn't a phrase hit:
 *
 *     coverage  = Σ wᵢ·creditᵢ / Σ wᵢ            (wᵢ = 1, or 0.2 for a stopword)
 *     slack     = smallest window holding every matched word − matched
 *     tightness = 1 / (1 + slack / (4 · matched))  (1 when ≤ 1 word matched)
 *     score     = min(0.95, coverage · (0.4 + 0.6 · tightness))
 *
 * so "seed loading continue" against the Anoxia title (all three words inside
 * a 7-word window) scores 0.85, while the same three words scattered through a
 * long row fall toward 0.4.
 *
 * A token containing a digit is REQUIRED wherever it appears: "PR 421" is not
 * a near-miss for "PR 420", it is a different PR.
 */
export function compileQuery(query: string, opts: CompileOptions = {}): TextMatcher {
  const raw = String(query ?? "").trim();
  const rawLower = raw.toLowerCase();
  const minLength = opts.minLength ?? 2;
  const phrase = normalizeText(raw);
  const tokens = queryTokenList(raw, minLength);
  const kept = tokens.filter((t) => !STOPWORDS.has(t));
  const significant = kept.length ? kept : tokens;
  const sig = new Set(significant);
  const weights = tokens.map((t) => (sig.has(t) ? 1 : STOPWORD_WEIGHT));
  const required = tokens.map((t, i) => /\d/.test(t) || (opts.requireAll === true && weights[i] === 1));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const stems = tokens.map(stem);
  const needles = significant.map(stemNeedle).filter(Boolean);
  const focus = [rawLower, ...significant].filter(Boolean);

  const verbatim = (text: string): boolean => rawLower.length > 0 && text.toLowerCase().includes(rawLower);

  const prefilter = (rawLine: string): boolean => {
    const lower = rawLine.toLowerCase();
    if (rawLower && lower.includes(rawLower)) return true;
    if (!needles.length) return false;
    for (const n of needles) if (!lower.includes(n)) return false;
    return true;
  };

  const score = (text: string): TextMatch | null => {
    const isVerbatim = verbatim(text);
    const fallback = (): TextMatch | null => (isVerbatim ? { score: VERBATIM_FLOOR, via: "verbatim" } : null);
    // No usable tokens ("—", "c#"): the old substring rule is all there is.
    if (!tokens.length) return fallback();

    const norm = normalizeText(text);
    if (phrase) {
      const padded = ` ${norm} `;
      if (padded.includes(` ${phrase} `)) return { score: PHRASE_SCORE, via: "phrase" };
      if (tokens.length > 1 && padded.includes(` ${phrase}`)) {
        return { score: PHRASE_PREFIX_SCORE, via: "phrase" };
      }
    }

    // One pass: each token's best credit, plus every place a significant token
    // occurred, so proximity can use the TIGHTEST window rather than wherever
    // each word happened to appear first.
    const words = norm ? norm.split(" ") : [];
    const credit = new Array<number>(tokens.length).fill(0);
    const hitWord: number[] = [];
    const hitToken: number[] = [];
    const hitCredit: number[] = [];
    for (let w = 0; w < words.length; w++) {
      const word = words[w]!;
      let wordStem: string | undefined;
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i]!;
        let c = 0;
        if (word === t) c = CREDIT.exact;
        else if (word.length < 2 || t.length < 2) c = 0; // a lone digit matches only itself
        else if ((wordStem ??= stem(word)) === stems[i]) c = CREDIT.stem;
        else if (t.length >= 3 && word.startsWith(t)) c = CREDIT.prefix;
        else if (t.length >= 4 && word.includes(t)) c = CREDIT.infix;
        else if (opts.typos && credit[i]! < CREDIT.typo1) {
          const budget = typoBudget(t.length);
          if (budget > 0) {
            // `budget + 1` is the "too far" sentinel — with a budget of 1 that
            // is 2, which read as a genuine two-edit typo and credited "helm"
            // for "loading". Only a distance WITHIN the budget is a match.
            const d = boundedEditDistance(t, word, budget);
            if (d === 1) c = CREDIT.typo1;
            else if (d === 2 && budget >= 2) c = CREDIT.typo2;
          }
        }
        if (c <= 0) continue;
        if (c > credit[i]!) credit[i] = c;
        if (weights[i] === 1) {
          hitWord.push(w);
          hitToken.push(i);
          hitCredit.push(c);
        }
      }
    }

    let earned = 0;
    let matched = 0;
    for (let i = 0; i < tokens.length; i++) {
      if (credit[i]! <= 0) {
        if (required[i]) return fallback();
        continue;
      }
      earned += weights[i]! * credit[i]!;
      if (weights[i] === 1) matched++;
    }
    if (earned <= 0) return fallback();

    // Smallest window of words holding every matched significant token at its
    // best credit — the classic sliding window over the occurrence list.
    let span = matched;
    if (matched > 1) {
      span = Infinity;
      const inWindow = new Map<number, number>();
      let left = 0;
      const best = (k: number): boolean => hitCredit[k] === credit[hitToken[k]!];
      for (let right = 0; right < hitWord.length; right++) {
        if (!best(right)) continue;
        inWindow.set(hitToken[right]!, (inWindow.get(hitToken[right]!) ?? 0) + 1);
        while (inWindow.size === matched) {
          if (best(left)) {
            span = Math.min(span, hitWord[right]! - hitWord[left]! + 1);
            const n = inWindow.get(hitToken[left]!)! - 1;
            if (n === 0) inWindow.delete(hitToken[left]!);
            else inWindow.set(hitToken[left]!, n);
          }
          left++;
        }
      }
    }
    const slack = Math.max(0, span - matched);
    const tightness = matched <= 1 ? 1 : 1 / (1 + slack / (PROXIMITY_SLACK * matched));
    const coverage = earned / totalWeight;
    let s = Math.min(TOKENS_MAX, coverage * (1 - PROXIMITY_SHARE + PROXIMITY_SHARE * tightness));
    if (isVerbatim && s < VERBATIM_FLOOR) return { score: VERBATIM_FLOOR, via: "verbatim" };
    s = Math.round(s * 100) / 100;
    return s > 0 ? { score: s, via: "tokens" } : null;
  };

  return { raw, phrase, tokens, needles, prefilter, score, focus };
}
