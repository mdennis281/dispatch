# iOS standalone PWA viewport: what actually governs the geometry

Research + audit, 2026-08-17. **No runtime behaviour changes in this PR.** This
document exists to stop the seventh attempt at this area being another guess.

Six PRs have touched it: #56, #57, #58, #59, #60, #61, #62, #79, #84, #85, #87.
Two of them (#85, #87) targeted the modal overlap and neither moved anything on
the device. The purpose here is to say why, and to name the one measurement that
is still missing.

---

## 0. The device readings this has to explain

iPhone, 430×932 CSS px, DPR 3, iOS 26-era, **installed standalone PWA**,
`viewport-fit=cover`, `apple-mobile-web-app-status-bar-style: black-translucent`.

```
shell   932 (fixed)     dead 0      over 59     kb 0
inner   873   vv 873    off 0       dvh 873     client 873
safe-t  59    safe-b 34
screen  932             scale 1.00
```

Same app in a Safari **tab**: `safe-t 0`, `safe-b 0`, `shell 775 (dvh)`,
`dead 121`, and it renders correctly. The bug is standalone-only.

Two rulers drawn by `position: fixed` boxes at absolute offsets
(`components/layout/ViewportDebug.tsx`), photographed on the device:

| ruler | mark | painted? |
|---|---|---|
| bottom | 833, 853 | **yes** |
| bottom | 873 (`client`), 893, 913, 930 | **no** |
| top | `top: 0` | yes — *above* the clock, at the glass edge |
| top | `top: 59` | yes — just *below* the status bar |

And the behavioural signature that matters most: **on a cold load the app renders
correctly (nav labels visible); after interaction it "goes back to the clipped
view."**

---

## 1. The model

### 1.1 One box, anchored at the top, that shrinks from the bottom

There is a single box that matters — the **initial containing block**, a.k.a. the
layout viewport. In this configuration:

* Its **origin is the top of the glass** (screen y = 0). The top ruler proves it:
  a `fixed` element at `top: 0` paints *above* the clock. `viewport-fit=cover` +
  `black-translucent` is doing exactly what it advertises — the web view is laid
  under the status bar, not below it.
* Its **height is `document.documentElement.clientHeight`**. On a cold launch
  that is 932 — the whole screen. After the first software-keyboard raise WebKit
  permanently shrinks it to **873 = 932 − 59** and never gives it back for the
  life of the session. `window.innerHeight`, `visualViewport.height`, `100dvh`
  and `clientHeight` all move together, which is why nothing in the page can
  notice the moment it happens.
* The 59px comes off the **bottom**. The origin does not move. So the screen band
  `[873, 932)` falls outside the layout viewport entirely.
* **Paint is clipped to that box.** This is the finding the bottom ruler bought
  and it is the one nothing else could have told us: rulers at 833 and 853 paint,
  rulers at 873, 893, 913 and 930 do not. Layout will happily give a `fixed` box
  a `getBoundingClientRect().bottom` of 932 in an 873-tall viewport. The
  compositor will never draw the last 59px of it.

This is the documented WebKit standalone-PWA shrink bug, with the same numbers
other people report on the same hardware (932 → 873, −59, iPhone Pro Max) —
see [the DEV writeup][dev] and WebKit [#237961][wk237961], which is still `NEW`.

### 1.2 The `env()` insets describe the screen, not the shrunk viewport

`safe-t 59` and `safe-b 34` are reported relative to the **full 932 screen**, not
relative to the 873-tall layout viewport that actually exists after the shrink:

* `safe-t 59` — still honest. The status bar really does overlap `[0, 59)` of the
  layout viewport. Padding 59 off the top is correct and necessary.
* `safe-b 34` — **no longer honest.** The home indicator lives at `[898, 932)`,
  which is entirely *below* 873. There is nothing to clear. Any element reserving
  34px at the bottom in this state is reserving it for a thing that is not inside
  the viewport.

That asymmetry is the crispest available tell that the insets are stale with
respect to the viewport, and it is why "the insets say we're being charged twice"
is the wrong reading of `safe-t 59` beside a short `inner`.

### 1.3 Everything above falls out of the model

| reading | why |
|---|---|
| `inner 873 = vv 873 = dvh 873 = client 873` | they are all the same shrunk box |
| `over 59` | shell pinned to 932, layout viewport 873 → 59px of the shell is past the paint edge |
| `dead 0` | `dead` is `screen − shellBottom`, and layout *does* grant the box 932. Layout is not paint. |
| `off 0`, `scale 1.00` | no keyboard, no pinch — the visual viewport is the layout viewport |
| `safe-t 59`, `safe-b 34` | §1.2 |
| Safari tab: `safe-t 0`, `dead 121`, renders fine | no `black-translucent`, so no insets; the shell follows `dvh` and never exceeds `clientHeight`, so nothing is clipped. The 121 is the URL bar. |

**And the "correct on load, wrong after interaction" signature.** On a cold load
`innerHeight === maxInnerHeight === 932`, so `standaloneShellHeight` returns 0,
`--cm-vh` is never set, and the shell falls back to `100dvh` = 932 = the
then-correct layout viewport. Everything fits. The first keyboard raise does two
things at once: it shrinks the viewport to 873, **and** it arms the high-water
correction, which pins the shell back at the old 932. Nothing else in the app
changes on interaction. That is the whole of symptom B.

### 1.4 Bottom-nav arithmetic, for completeness

`--cm-bottom-nav-strip` + `--cm-bottom-nav-clear` = `52 + safe-b` = **86px**.
The bar is the shell's last in-flow row, so with the shell at 932 it occupies
`[846, 932)`. Paint stops at 873. **27 of 86px are visible**; the labels sit low
in the 52px slot band and land past the paint edge. Exactly as reported.

### 1.5 What the platform does and doesn't give you

* `100dvh` / `100svh` / `100lvh` are all the *same number* here after the shrink,
  because the shrink moves the layout viewport itself. `svh`/`lvh` are not an
  escape hatch — there is no URL bar in standalone for them to differ over.
* `-webkit-fill-available` is worse, not better: it "never accounts for the extra
  space when `viewport-fit=cover` is enabled" ([#237961][wk237961]).
* `interactive-widget=resizes-content` / `resizes-visual` is **not implemented in
  WebKit** ([bug #259770][wk259770], [WebKit standards-positions #65][wkpos65]) —
  Chrome 108+ and Firefox 132+ only. It is ignored in standalone. Do not add it.
* The widely copied `html { min-height: calc(100% + env(safe-area-inset-top)) }`
  hack is about making the *document* tall enough that iOS's standalone scroll
  doesn't leave a white bar. It has nothing to say about a `fixed`,
  `overflow: hidden` shell. `standaloneShellHeight`'s add-back is a JS
  reimplementation of that hack applied to a case it was never about.

---

## 2. Which of our mechanisms are wrong

### 2.1 `standaloneShellHeight`'s high-water mark — **convicted. This is symptom B.**

`stores/viewport.ts:156-173`. With the measured inputs
(`innerHeight 873`, `maxInnerHeight 932`, `safeTop 59`, `screenHeight 932`):

```
shrunk    = 932 - 873 = 59 > 4          → true
base      = maxInnerHeight              = 932
statusBar = safeTop > 0 && 932 - 932 >= 57   → FALSE → 0
return      base                        = 932
```

So the `932 (fixed)` on the readout comes **entirely from the high-water mark**;
the add-back is not even firing in this state. `--cm-vh: 932px` is written onto a
shell whose layout viewport is 873, and the difference is `over 59` — the band
the device never paints. Convicted by `over 59` and by the bottom ruler.

It also explains the cold-load/after-interaction split precisely (§1.3), which no
other mechanism in the app does.

### 2.2 The status-bar add-back — **ruled OUT as the active cause, ruled IN as wrong**

The task asked for an explicit verdict, and it is two-part:

* **Out**, as the cause of *this* reading. The gate `screenHeight - base >= safeTop - 2`
  is false when `base` is already 932, so the branch is dormant here.
* **In**, as wrong, and it must still go. It is a second, independent road to the
  identical broken 932 — one that fires on a *cold start where `innerHeight` is
  already 873* (the shrink is sticky until force-quit, so relaunching into the
  browser process's shrunk state is a real path). `viewport.test.ts:42` pins
  exactly that: `standaloneShellHeight(true, 873, 873, 59, 932) === 932`.

Its premise is refuted by the ruler. The premise, from the doc comment:

> WebKit also subtracts that same band from `innerHeight`/`100dvh`, so a shell
> sized in `dvh` and then padded by `safe-area-inset-top` pays for the status bar
> TWICE … Adding the top inset back is what makes the shell reach the bottom of
> the display.

The shell **cannot** reach the bottom of the display. Paint stops at
`clientHeight`. There is no band down there to recover; there is only a band the
compositor will not touch. Adding 59 does not extend the app, it extends the part
of the app that is thrown away.

The claim that the correction is "self-limiting rather than a guess about a
device" is also wrong on its own terms. The gate
`safeTop > 0 && screenHeight - base >= safeTop - 2` is satisfied by *any* device
whose window is a status bar short of the screen for *any* reason — which, after
the shrink bug, is every notched iPhone. It does not discriminate between "the UA
double-charged us" and "the UA shrank the viewport", which are the two cases it
exists to tell apart.

### 2.3 `keyboardInset`'s recovered-band term — dead once the above go

`viewport.ts:82`, `+ Math.max(0, shellHeight - windowHeight)`. This exists only
to compensate for a shell deliberately taller than the window. When the shell
equals the viewport the term is 0 and the line is dead code — but it must be
removed *with* the corrections, not after, or an intermediate state over-pads the
composer. `viewport.test.ts:95-102` pins the behaviour that has to change
(`keyboardInset(932, 873, 519, 0) === 413`).

### 2.4 `dead` — a decoy, not a bug

`dead` is honestly measured now (#84 replaced the self-confirming arithmetic with
`getBoundingClientRect().bottom`), but it still reads 0 in the broken state,
because layout really does give the box 932. It cannot go non-zero while the
shell is pinned. `over` is the number that carries information. Keep `over`,
demote or relabel `dead`, and make sure nobody ships against `dead 0` a fifth
time.

### 2.5 `--cm-safe-bottom` / `--cm-bottom-nav-clear` — correct code, stale input

Not cargo cult: on a cold 932 viewport the home indicator *is* inside the box and
34px of clearance is right. After the shrink it is not (§1.2), and every consumer
of `--cm-safe-bottom` reserves 34px for nothing. Fix the shell first, then gate
the bottom inset on the viewport actually reaching the screen. Low priority — it
is a 34px waste, not a clip.

### 2.6 Keep

`html, body { overflow: hidden }`, the `fixed` shell (#60), `window.scrollTo(0, 0)`
in `apply()`, `--cm-kb`, `cm-safe-pad` / `cm-safe-t` / `cm-safe-x`, `PaintRuler`,
`AnnotatorGeometryDebug`. None of these are implicated, and the first two stop
rubber-band panning that is real.

---

## 3. Symptom A — and why I cannot close it from here

The contradiction is genuine and worth stating sharply: a `fixed` element at
`top: 59` demonstrably paints below the clock, so a `fixed inset-0` box with
`padding-top: 59px` must put its first in-flow child below the clock too. Here is
everything I could rule out, and what is left.

**Ruled out — the build is not stale.**
`%LOCALAPPDATA%\claude-manager\app\release-manifest.json` is sha
`b895a314a042d6305418df39f8ad2ad9057a3db9` — that is `b895a31`, PR #87, current
`main` — built `2026-08-17T13:02:18Z`. The shipped chunk
`packages/client/dist/assets/ImageAnnotator-3trKfWOG.js` contains `hdr-t`,
`panel-t`, `paddingBottom` and `39.98rem`. **The inline-padding fix and its
on-screen instrument are both live on the device.**

**Ruled out — the containing block is the viewport.**
The annotator portals to `document.body` (`ImageAnnotator.tsx:299`). Per
[CSS-Position §fixed-positioning-containing-block][cbspec], only `transform`,
`perspective` and `filter` (plus `will-change` of those) displace a `fixed`
element's containing block. `index.css` sets none of them on `html`, `body` or
`#root` — the only ancestors a body-portal child has. The `backdrop-blur` scrim
is a *sibling* of the panel, not an ancestor. So the annotator root resolves
against the same box the ruler measured.

**Ruled out — the padding is attempted.**
`FULL_BLEED = "(max-width: 39.98rem)"` = 639.68px against a 430px window → true
(media-query `rem` is always the initial 16px, so no font-size can move this).
`sm:` (40rem) is off, `max-sm:` is on. So the panel takes
`style={{ paddingTop: 59, paddingBottom: 34 }}` and the root takes no padding.

**Ruled out — the header is in the padded flow.**
The panel is `h-full` of a `fixed inset-0` parent (definite 873), `box-sizing:
border-box`, so its content box starts at y = 59, and `<header>` is the first
in-flow child of the fragment `Editor` returns.

**The control that should have caught this.** `TopBar` does the identical thing —
`cm-safe-t` → `padding-top: 59px`, inside a box anchored at y = 0 — and renders
correctly. It has never been reported under the clock. Whatever kills the
annotator's 59px does not kill the top bar's.

**So: I cannot explain symptom A, and I am not going to invent a mechanism for
it.** Two readings survive:

1. **The annotator report is stale relative to the ruler photos.** The top ruler
   was added *by #87 itself* (`ViewportDebug.tsx`, +24 lines in `b895a31`). If the
   ruler photos come from the #87 build but the editor was last opened on #85's,
   "neither changed anything" is a carry-over. This requires #85 to have failed
   for its own reason — and there is one available: `main.tsx:54` registers a
   service worker (`/sw.js`), so an installed PWA can be running a cached shell
   that references a pre-#85 chunk regardless of what is on disk.
2. **Something zeroes the padding only while the editor is open** — the only live
   candidates being `safeTop` reading 0 from the store at that moment, or `phone`
   resolving false.

### The one measurement that settles it

#87 already shipped the instrument. Nobody has photographed it.

> **On the phone: More → toggle the viewport debug on, open the image editor, and
> photograph the cyan box in its top-right corner.** It reports `pad-t`, `var-t`,
> `js-t`, `panel-t`, `hdr-t`.

| reading | verdict |
|---|---|
| `pad-t: 59px`, `hdr-t: 59` | the fix works; the report is stale. Stop — no overlay change needed. |
| `pad-t: 0px` | the padding never applied. `js-t` then separates "`safeTop` was 0" from "`phone` was false". |
| `pad-t: 59px`, `hdr-t: 0` | the header is not in the padded flow — a new bug in the panel's box, not a viewport bug. |
| `panel-t` ≠ 0 | the panel's origin is not the glass top, and the containing-block analysis above is wrong. |

Also do **one hard reload / service-worker update on the phone** before judging
anything, for the reason in reading 1.

Do not change any overlay code before this readout exists. Every further attempt
is unfalsifiable without it, which is how this got to three PRs.

---

## 4. Recommended plan

Smallest first. Each step names what it predicts on-device, so it can fail loudly.

**Step 0 — read the annotator debug box (no code).** §3. Also force a SW update.
Predicts: either symptom A is already fixed, or we learn which of two mechanisms
ate the padding. Cost: one screenshot.

**Step 1 — stop the shell exceeding the layout viewport.** Delete both
corrections so `standaloneShellHeight` returns 0 and the shell falls back to
`height: 100dvh` (equivalently: clamp to `documentElement.clientHeight`).
*Predicts:* `shell` reads `873 (dvh)`, **`over 0`**, `dead 59`, and the bottom
nav's labels are visible **and stay visible after a keyboard raise** — which is
the specific thing that regresses today. *Falsifier:* if a visibly wrong band
appears at the bottom of the screen, the shell was not the whole story and step 2
is needed. If nothing appears — because that band was never paintable — we are
done. This is the whole of symptom B and it is a deletion, not an addition.

**Step 2 — only if step 1 leaves a visible band: attack the shrink, not the
symptom.** The community workaround forces WebKit to re-measure after keyboard
blur — `display: none` → sync reflow → `display: ''` on a full-viewport-height
element, ~140ms after blur ([DEV writeup][dev]). It fits the existing burst
sampler in `startViewportTracking`. *Predicts:* `inner`/`dvh`/`client` return to
932 a beat after blur and `max − inner` returns to 0, so no correction is needed
at all. *Note:* it flickers; that article masks it with a blur veil.

**Step 3 — make `--cm-safe-bottom` honest.** Gate it on
`screenHeight - clientHeight <= 2`; otherwise treat the bottom inset as 0.
*Predicts:* the nav stops being an 86px band in an 873 viewport, and `safe-b`
stops reserving space for a home indicator that is outside the viewport.

**Step 4 — overlays.** Entirely determined by step 0. Do nothing here first.

**Instrument upgrades (cheap, and this is how the last three PRs were finally
made falsifiable):** add `icb` (`documentElement.clientHeight`) beside `screen`;
add a ruler mark at `screen − safe-b` so "is the home indicator inside the
viewport" is answerable by eye; if step 0 clears the annotator but other overlays
still overlap, port `AnnotatorGeometryDebug` to `Modal` and `CommandPalette`.

---

## 5. What to delete

| what | where | why |
|---|---|---|
| the status-bar add-back (`statusBar` branch) | `stores/viewport.ts:170-172` | §2.2 — refuted by the PaintRuler |
| its three tests | `stores/viewport.test.ts:38-56` | pin the refuted behaviour |
| the high-water mark (`shrunk`, `base`, `maxInnerHeight` and its plumbing in the store + tracker) | `stores/viewport.ts`, `ViewportDebug.tsx` | §2.1 — the direct cause of `over 59` |
| `standaloneShellHeight` itself, and `--cm-vh` | ditto | with both branches gone it returns 0 always; the shell is just `100dvh` |
| the recovered-band term `+ Math.max(0, shellHeight - windowHeight)` | `stores/viewport.ts:82` | §2.3 — dead once the shell equals the window |
| its test | `stores/viewport.test.ts:95-102` | ditto |
| the `dead` row, or its prominence | `ViewportDebug.tsx:142,152` | §2.4 — cannot go non-zero in the broken state |

And rewrite the prose that narrates the double-charge theory, which is currently
the load-bearing explanation in three places: `App.tsx:91-125`, the
`standaloneShellHeight` doc comment (`stores/viewport.ts:121-155`), and the
"what to look for" list in `ViewportDebug.tsx:5-31`. Those comments are why the
theory survived four PRs — they read as established fact and they are the first
thing the next person will trust.

---

## Sources

* [Fixing the iOS standalone-PWA keyboard bug that shrinks your viewport for good — DEV][dev] — same hardware, same numbers (932 → 873, −59), and the `display:none`/reflow re-measure workaround. Also lists what does *not* work: `interactive-widget`, locking the shell `fixed inset-0 overflow-hidden`, moving inputs out of `fixed` ancestors, `scrollTo`, `visualViewport` listeners, `height: 100%` instead of `dvh`.
* [WebKit #237961 — Standalone with viewport-fit cover causes overscroll issues, breaks position fixed and -webkit-fill-available][wk237961] — still `NEW`. `-webkit-fill-available` never accounts for the extra space under `viewport-fit=cover`; `position: fixed` with `top:0; bottom:0` still leaves a gap.
* [WebKit #259770 — Implement the interactive-widget property in the viewport meta tag][wk259770] and [WebKit standards-positions #65][wkpos65] — unimplemented; Chrome 108+/Firefox 132+ only.
* [CSS Positioned Layout — fixed positioning containing block][cbspec] / [MDN `position`][mdnpos] — `transform`, `perspective`, `filter` are the only properties that displace a `fixed` element's containing block.
* [Apple — Supported Meta Tags][applemeta] — `black-translucent`: "the web content is displayed on the entire screen, partially obscured by the status bar."
* [cvan — CSS for `env(safe-area-inset-top)` for iOS Add-to-Homescreen / PWA][cvan] — the widely copied `min-height: calc(100% + env(safe-area-inset-top))` document hack (§1.5).
* [iOS 17 PWA `position: fixed` breaks after a while — Apple Developer Forums][adf744327] and [iOS 26 / WebKit fixed-position header misaligned after keyboard interaction][adf797097] — `visualViewport.offsetTop` not resetting to 0 after dismissal; a focusable element inside a `fixed` box can displace the whole box.

[dev]: https://dev.to/cederhook/fixing-the-ios-standalone-pwa-keyboard-bug-that-shrinks-your-viewport-for-good-63d
[wk237961]: https://bugs.webkit.org/show_bug.cgi?id=237961
[wk259770]: https://bugs.webkit.org/show_bug.cgi?id=259770
[wkpos65]: https://github.com/WebKit/standards-positions/issues/65
[cbspec]: https://drafts.csswg.org/css-position/#fixed-positioning-containing-block
[mdnpos]: https://developer.mozilla.org/en-US/docs/Web/CSS/position
[applemeta]: https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariHTMLRef/Articles/MetaTags.html
[cvan]: https://gist.github.com/cvan/6c022ff9b14cf8840e9d28730f75fc14
[adf744327]: https://developer.apple.com/forums/thread/744327
[adf797097]: https://developer.apple.com/forums/thread/797097
