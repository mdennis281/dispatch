# Similarity search — one primitive for chats and memories

`packages/shared/src/text-match.ts` · used by `chat_find` (`InspectService.findChats`)
and memory recall (`scoreCorpus`).

## The problem, measured

`chat_find` matched a lowercase substring, all or nothing, newest first. On the
live store (2,520 chats) that fails two ways:

1. **It misses.** Any query that crosses punctuation, reorders words, inflects
   one or misspells one finds nothing — the contiguous substring isn't there.
2. **It mis-ranks.** `continue without reload` *does* substring-match the title
   "Anoxia: Continue without reload — modular seed loading" — but that chat came
   back **5th of 5**, under four newer chats that merely quoted its title. With
   no score, recency was the only order.

Memory recall was already token-based (stems, stopwords, IDF), but its
whole-phrase bonus still compared raw strings — so `steam lobby rejoin` never
earned the name bonus on `steam-lobby-rejoin-desync`.

## Algorithm

Token overlap, not alignment. Every step is linear in the text, and the only
edit-distance work is bounded and confined to short fields.

### Normalization

```
NFKD → strip combining marks → lowercase → every run of [^\p{L}\p{N}] → " "
```

Em/en dashes, colons, underscores, hyphens, slashes and dots all become a
single space; `café` → `cafe`. Tokens are the space-split result, ≥ 2 chars —
except a lone digit, which is kept: in `exit code 1` the digit is the question.
Stemming is the conservative suffix fold memory already used (`-ing`, `-ed`,
`-ies→y`, `-s`, de-doubling), now shared.

### Scoring a field (0–1)

| How a query token is found in the field  | credit |
|------------------------------------------|-------:|
| exact token                              | 1.00   |
| same stem (`seeds` ↔ `seed`)             | 0.95   |
| prefix of a token (`reload` → `reloading`)| 0.85  |
| inside a token (`chats` in `findchats`)  | 0.70   |
| typo, 1 edit — **titles only**           | 0.70   |
| typo, 2 edits (tokens ≥ 8 chars) — titles only | 0.55 |

```
coverage  = Σ wᵢ·creditᵢ / Σ wᵢ              wᵢ = 1, or 0.2 for a stopword
slack     = smallest window holding every matched word − matched
tightness = 1 / (1 + slack / (4 · matched))   (1 when ≤ 1 word matched)
score     = min(0.95, coverage · (0.4 + 0.6·tightness))
```

The window is the true minimum (sliding window over every occurrence), not
first occurrences, so a row that rambles and then says the phrase tightly is
judged by the tight part. Proximity owns 60% of the score: all words present
but scattered across a long turn bottoms out at **0.4**.

Hard rules:

- a token containing a **digit** must match, or the field doesn't: `PR 421` is
  not a near-miss for `PR 420`;
- with `requireAll` (transcript rows), **every** significant token must match.

Overrides, in order:

- normalized query appears word-aligned and contiguous → **1.00** (phrase)
- …with its last word still a prefix (`continue without relo`) → **0.97**
- raw query appears verbatim in raw text → at least **0.90** (old rule's floor)

Token-built scores cap at 0.95 so the exact phrase never ties a near-phrase.
The verbatim floor makes the new rule a **strict superset** of the old one: no
search that hit before can miss now, and `—`, `c#` or a mid-word fragment like
`elease` still work exactly as they did.

Typo distance is optimal-string-alignment (Levenshtein + adjacent swap),
banded to `k` so it is O(len·k), and only for query tokens ≥ 4 chars (1 edit)
or ≥ 8 chars (2 edits). It runs on titles, never on transcripts.

## Cost

Transcripts are where the bytes are, so the scan keeps its shape: a cheap test
on the **raw** JSONL line, and `JSON.parse` + scoring only on lines that pass.

- **Prefilter:** the line contains the verbatim query, **or** every significant
  (non-stopword) query token's stem-prefix. One `includes` per word, same as
  before — just k of them instead of one.
- **Content rule:** a transcript row must contain *every* significant word
  (any order, any punctuation) — enforced by the scorer (`requireAll`), not
  just the substring prefilter, which a `1` in a timestamp would satisfy. A
  20 KB assistant turn sharing one word with the query is noise, not a hit.
  Rows then need score ≥ 0.5, which is purely a proximity cut: two words
  within ~40 words of each other pass, the same words 3,000 words apart (0.4)
  do not.
- **Titles:** all already in memory, scored once per chat per call (cached),
  with typos on; need ≥ 0.65 — two words of three side by side pass, one of
  two does not.

Measured on the live stable store (read-only):

| | substring (before) | similarity (after) |
|---|---|---|
| titles, ~2,520 chats, typo-tolerant | <1 ms | 17–40 ms |
| content: prefilter + parse + score, 364 transcripts / 219 MB / 84k lines | 1.34–1.46 s | 1.51–1.96 s |
| lines that reach `JSON.parse` | 5–33 | 26–245 |

Same order as before; the extra parsed lines are a rounding error against the
I/O. The same run checked the superset claim on real rows: every
user/assistant row the old rule hit is still a hit (0 lost across the three
queries), and `continue without reload` finds 15 rows where substring found 5.

## Ranking and paging

`chat_find` now returns **best match first** and puts a score on every chat and
every hit (`(0.92)` in the rendered text, `score` in the structured result).
Ties go to the chat whose **title** matched, then to the newer chat — a chat's
title is its own name; a quote of it elsewhere is a mention.

Ranking is **within a page**. The page boundary stays a recency cut because
the scan budget (256 MB) walks newest-first — a global ranking would mean
reading every transcript before answering, which is the cost the budget exists
to cap. Title matches across the *whole* search space are still listed on page
one when they fit, exactly as before, so the strongest signal is never
budget-dependent.

New `chat_find` arguments:

- `match: "similar" | "exact"` — default `similar`. `exact` is the old rule,
  unranked, no scores: for an exact error string where near-misses are noise.
- `minScore` (0–1) — threshold both titles and rows. Defaults 0.65 / 0.5.

Both are part of the cursor fingerprint, so a cursor can't be replayed onto a
search with a different mode.

## Memories

Memory recall already had the right shape (tokens × IDF × field weights,
calibrated 0–100 against a real 141-memory store), so this change is
deliberately small and doesn't move its thresholds:

- tokenizing, stemming, stopwords and Jaccard come from the shared module, so
  "same word" means the same thing in both stores (and accents now fold rather
  than split a token);
- the whole-phrase bonus is checked in raw **and** normalized space, so a
  kebab-case name or an em-dashed description finally earns it.

`compileQuery` is the reuse point for anything else that needs it: a store's
search compiles the query once and calls `score(field)` per row, or
`prefilter(raw)` first when rows are large.

## Before / after (live store)

Title hits at the default threshold, best first:

| query | before | after |
|---|---|---|
| `continue without reload` | 1 hit, ranked **5th of 5** behind quoters | **1.00** Anoxia: Continue without reload — modular seed loading, ranked 1st |
| `reload modular seed` | 0 | **1.00** Anoxia: Continue without reload — modular seed loading |
| `modular-seed-loading` | 0 | **1.00** same |
| `seed loading continue` | 0 | **0.88** same · 0.65 "feat(swap): Continue, Load and New game swap…" |
| `contnue without relaod` | 0 | **0.80** same |
| `load time goes where` | 0 | **0.95** Anoxia: where the load time goes · 0.95 …where the remaining load time goes |
| `initial load speedups` | 0 | **1.00** Anoxia: more initial-load speedups (×2) · 0.67 Initial Load Hitches Debug |

## Known limits / follow-ups

- **Accents in transcripts.** The content prefilter tests raw lines without
  NFKD-folding them (folding 800 MB per query is not cheap), so `cafe` won't
  find a row that only says `café`. Titles and memories do fold. Verbatim
  `café` still matches.
- **No typos in transcripts**, by design (cost). A misspelled query still finds
  the chat by its title.
- **Memory typo tolerance** is a natural next step, but it shifts the
  calibrated auto-surface bands (`SURFACE_MIN_SCORE`/`SURFACE_FULL_SCORE`), so
  it wants a re-calibration pass against the live corpus, not a drive-by.
- `chat_read`'s `grep` view, the sidebar search and `memory_search` (literal
  by design) are untouched.
