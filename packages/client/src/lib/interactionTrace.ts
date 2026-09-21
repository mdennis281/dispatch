/**
 * A flight recorder for touch, scroll and layout on a device you can't inspect.
 *
 * The viewport readout (`ViewportDebug`) answers "how big is everything right
 * now". It cannot answer "what happened during that flick" — a scroll jolt on
 * the iPhone is over in three frames, and by the time a screenshot is taken the
 * numbers are all at rest again. Every fix for iOS scrolling so far has been
 * built from a description of the glitch rather than a recording of it, and
 * most have missed. This records it.
 *
 * While the readout is on, every event that can move the transcript is logged
 * into a ring buffer with a timestamp: touches (with finger position), scroll
 * events (with the scroller's offset and its DELTA), programmatic scrolls (WHO
 * set `scrollTop` — captured by hooking the setter, with the caller's frame),
 * content growth in the scroller (a `ResizeObserver` on its children — this is
 * what a late image does), image loads (with whether the image sat ABOVE the
 * viewport, which is the case WebKit's missing scroll anchoring cannot cope
 * with), focus changes, and the visual-viewport/keyboard readings. The buffer
 * can be copied to the clipboard or posted to the server, and `?trace` renders
 * it as a timeline (`components/debug/TraceViewer.tsx`).
 *
 * Costs nothing when off: nothing here is installed until `start()` runs, and
 * the readout is the only caller.
 */
import { create } from "zustand";
import { useViewport } from "../stores/viewport.js";

/** One recorded moment. `t` is ms since the recorder started. */
export interface TraceEntry {
  t: number;
  k: TraceKind;
  /** Element the event concerned — see `describe`. */
  el?: string;
  [extra: string]: unknown;
}

export type TraceKind =
  | "touch"
  | "pcancel"
  | "scroll"
  | "set"
  | "size"
  | "img"
  | "focus"
  | "blur"
  | "vv"
  | "shift"
  | "note";

export interface TraceSnapshot {
  meta: {
    startedAt: string;
    ua: string;
    standalone: boolean;
    screen: { w: number; h: number };
    inner: { w: number; h: number };
    dpr: number;
    /** What the recorder was watching for `size` — the last scroller touched. */
    scroller?: string;
  };
  entries: TraceEntry[];
}

/** Oldest entries fall off first. A 2s drag is ~120 touchmoves, so this is minutes. */
const CAPACITY = 4000;
/** How many entries the overlay tail shows. */
const TAIL = 8;
/** How many touch points the on-screen finger trail keeps. */
const TRAIL = 48;

interface TraceStore {
  /** Entries recorded since start (or clear) — including ones that fell off. */
  count: number;
  tail: TraceEntry[];
  /** Recent touch points, for the on-screen trail. */
  trail: Array<{ x: number; y: number; p: string; t: number }>;
  /** Last copy/send result, for the overlay to acknowledge. */
  status: string;
}

export const useTrace = create<TraceStore>(() => ({ count: 0, tail: [], trail: [], status: "" }));

let entries: TraceEntry[] = [];
let total = 0;
let t0 = 0;
let startedAt = "";
let publishTimer = 0;
let scrollerName: string | undefined;

function now(): number {
  return Math.round((performance.now() - t0) * 10) / 10;
}

/**
 * Publish to the store on a short timer rather than per entry: a touchmove
 * stream is 60Hz, and re-rendering the overlay at that rate would itself be a
 * source of the jank being recorded.
 */
function publish(): void {
  if (publishTimer) return;
  publishTimer = window.setTimeout(() => {
    publishTimer = 0;
    const trail = [];
    for (let i = entries.length - 1; i >= 0 && trail.length < TRAIL; i--) {
      const e = entries[i]!;
      if (e.k === "touch") trail.push({ x: e.x as number, y: e.y as number, p: e.p as string, t: e.t });
    }
    useTrace.setState({ count: total, tail: entries.slice(-TAIL), trail: trail.reverse() });
  }, 200);
}

function push(e: Omit<TraceEntry, "t">): void {
  total++;
  entries.push({ ...e, t: now() } as TraceEntry);
  if (entries.length > CAPACITY) entries.splice(0, entries.length - CAPACITY);
  publish();
}

/** A free-text marker, so the person holding the phone can label what they just did. */
export function traceNote(text: string): void {
  if (t0) push({ k: "note", text });
}

/**
 * A short, stable name for an element. Tag, id, the data attributes the shell
 * uses as landmarks, and the first couple of `cm-` classes — enough to tell the
 * transcript scroller from a code block's, without dumping Tailwind soup.
 */
export function describe(target: EventTarget | null | undefined): string {
  if (target === document) return "document";
  if (target === window) return "window";
  if (!(target instanceof Element)) return "?";
  let s = target.tagName.toLowerCase();
  if (target.id) s += `#${target.id}`;
  for (const a of ["data-transcript", "data-cm-shell", "data-row-id"]) {
    if (target.hasAttribute(a)) s += `[${a.slice(5)}]`;
  }
  const cls = Array.from(target.classList)
    .filter((c) => c.startsWith("cm-"))
    .slice(0, 2);
  if (cls.length) s += `.${cls.join(".")}`;
  return s.slice(0, 48);
}

/** The nearest vertical scroller a touch or an image lives in. */
function scrollerOf(el: Element | null): Element | null {
  return el?.closest(".cm-scroll, [data-transcript]") ?? null;
}

/**
 * The first stack frame outside this file, trimmed to `fn@file:line:col`.
 * Chrome writes `at fn (url:l:c)`, Safari `fn@url:l:c`; both survive stripping
 * the URL down to its basename. Minified names still correlate within a build.
 */
function caller(): string {
  const lines = (new Error().stack ?? "").split("\n").map((l) => l.trim());
  const line =
    lines.find((l, i) => i > 0 && l && !/interactionTrace|^Error$/.test(l)) ?? lines[1] ?? "";
  return line
    .replace(/^at\s+/, "")
    .replace(/https?:\/\/[^\s)]*\//g, "")
    .replace(/[()]/g, "")
    .slice(0, 90);
}

export function snapshot(): TraceSnapshot {
  const nav = navigator as Navigator & { standalone?: boolean };
  return {
    meta: {
      startedAt,
      ua: navigator.userAgent,
      standalone: nav.standalone === true || matchMedia("(display-mode: standalone)").matches,
      screen: { w: screen.width, h: screen.height },
      inner: { w: innerWidth, h: innerHeight },
      dpr: devicePixelRatio,
      scroller: scrollerName,
    },
    entries: entries.slice(),
  };
}

export function clearTrace(): void {
  entries = [];
  total = 0;
  t0 = performance.now();
  startedAt = new Date().toISOString();
  useTrace.setState({ count: 0, tail: [], trail: [], status: "" });
}

export function setTraceStatus(status: string): void {
  useTrace.setState({ status });
  window.setTimeout(() => {
    if (useTrace.getState().status === status) useTrace.setState({ status: "" });
  }, 2500);
}

/** Installs every listener and hook. Returns the teardown; idempotent per call. */
export function startInteractionTrace(): () => void {
  clearTrace();
  const disposers: Array<() => void> = [];
  const on = <K extends keyof DocumentEventMap>(
    type: K,
    fn: (e: DocumentEventMap[K]) => void,
    opts: AddEventListenerOptions = { capture: true, passive: true },
  ) => {
    document.addEventListener(type, fn, opts);
    disposers.push(() => document.removeEventListener(type, fn, opts));
  };

  // ---- touch -------------------------------------------------------------
  let touching = false;
  const touch = (p: "start" | "move" | "end" | "cancel") => (e: TouchEvent) => {
    const t = e.touches[0] ?? e.changedTouches[0];
    touching = p === "start" || p === "move";
    const entry: Omit<TraceEntry, "t"> = {
      k: "touch",
      p,
      x: t ? Math.round(t.clientX) : -1,
      y: t ? Math.round(t.clientY) : -1,
      n: e.touches.length,
    };
    if (p === "start") {
      const target = e.target instanceof Element ? e.target : null;
      entry.el = describe(target);
      entry.in = describe(scrollerOf(target));
      watchScroller(scrollerOf(target));
    }
    if (e.defaultPrevented) entry.prevented = true;
    push(entry);
  };
  on("touchstart", touch("start"));
  on("touchmove", touch("move"));
  on("touchend", touch("end"));
  on("touchcancel", touch("cancel"));
  // iOS cancels the pointer stream the moment it decides the gesture is a
  // scroll. Seeing WHEN that happens relative to the first scroll event is
  // the difference between "the page grabbed it" and "the page hesitated".
  on("pointercancel", (e) => push({ k: "pcancel", el: describe(e.target) }));

  // ---- programmatic scrolls ---------------------------------------------
  // Hook the setters so a jolt that came from OUR code (pageAnchor, the
  // scroll-to-bottom, a focus reveal) is labelled with who did it, and one
  // that didn't is unambiguously the browser's.
  let programmatic = 0;
  const desc = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
  if (desc?.set && desc.get) {
    const orig = desc;
    Object.defineProperty(Element.prototype, "scrollTop", {
      configurable: true,
      enumerable: orig.enumerable,
      get: orig.get,
      set(this: Element, v: number) {
        programmatic++;
        push({ k: "set", how: "scrollTop=", el: describe(this), v: Math.round(v), by: caller() });
        orig.set!.call(this, v);
      },
    });
    disposers.push(() => Object.defineProperty(Element.prototype, "scrollTop", orig));
  }
  const wrap = <T extends object, K extends keyof T>(obj: T, key: K, how: string) => {
    const orig = obj[key] as unknown as (...args: unknown[]) => unknown;
    if (typeof orig !== "function") return;
    (obj as Record<K, unknown>)[key] = function (this: unknown, ...args: unknown[]) {
      programmatic++;
      const a = args[0];
      const v =
        typeof a === "number"
          ? Math.round(a)
          : a && typeof a === "object"
            ? JSON.stringify(a).slice(0, 40)
            : String(a ?? "");
      push({ k: "set", how, el: describe(this as EventTarget), v, by: caller() });
      return orig.apply(this, args);
    };
    disposers.push(() => {
      (obj as Record<K, unknown>)[key] = orig;
    });
  };
  wrap(Element.prototype, "scrollTo", "scrollTo");
  wrap(Element.prototype, "scrollBy", "scrollBy");
  wrap(Element.prototype, "scrollIntoView", "scrollIntoView");
  wrap(window, "scrollTo", "window.scrollTo");
  wrap(window, "scrollBy", "window.scrollBy");

  // ---- scroll -------------------------------------------------------------
  // `scroll` doesn't bubble, but it does capture — one listener on the
  // document sees every scroller in the page.
  const lastTop = new WeakMap<Element, number>();
  on("scroll", (e) => {
    const el = e.target instanceof Element ? e.target : document.scrollingElement;
    if (!el) {
      push({ k: "scroll", el: "window", top: Math.round(scrollY) });
      return;
    }
    const top = Math.round(el.scrollTop);
    const prev = lastTop.get(el);
    lastTop.set(el, top);
    const entry: Omit<TraceEntry, "t"> = {
      k: "scroll",
      el: describe(el),
      top,
      h: el.scrollHeight,
      c: el.clientHeight,
    };
    if (prev !== undefined) entry.dy = top - prev;
    if (touching) entry.fin = true;
    if (programmatic) {
      entry.prog = true;
      programmatic = 0;
    }
    push(entry);
    watchScroller(el);
  });

  // ---- content growth in the active scroller ----------------------------
  // A row above the reader getting taller is the whole story of the iOS jolt:
  // WebKit (< Safari 27) has no scroll anchoring, so the transcript shoves by
  // exactly the growth. Watch the scroller's children and log every height
  // change with where the reader was at the time.
  let watched: Element | null = null;
  // Filled by the observer's own first callback, NOT seeded from a rect: the
  // observer reports the content box, a rect is the border box, and seeding
  // from the wrong one logged a phantom "-17" for every row at t=0.
  let heights = new WeakMap<Element, number>();
  let observed = new WeakSet<Element>();
  // Rows are `div.cm-row-cv` — indistinguishable by name — so a row is labelled
  // by its position among the rows and where its top sits relative to the
  // reader, which is the part that decides whether growth is felt.
  const label = (el: Element): string => {
    const rows = watched ? Array.from(watched.querySelectorAll(".cm-row-cv")) : [];
    const i = rows.indexOf(el);
    if (i < 0) return describe(el);
    const rel = watched ? Math.round(el.getBoundingClientRect().top - watched.getBoundingClientRect().top) : 0;
    return `row[${i}/${rows.length}]@${rel}`;
  };
  const ro: ResizeObserver | null =
    typeof ResizeObserver === "function"
      ? new ResizeObserver((records) => {
          for (const r of records) {
            // A removed row reports once more, at zero, and would otherwise
            // stay retained by the observer for the rest of the recording:
            // the scroller persists across chat switches (ChatView has no
            // key), only its rows are swapped, so every chat visited while
            // recording would pile up in here.
            if (!r.target.isConnected) {
              ro?.unobserve(r.target);
              heights.delete(r.target);
              continue;
            }
            const h = Math.round(r.contentRect.height);
            const prev = heights.get(r.target);
            heights.set(r.target, h);
            if (prev === undefined || prev === h) continue;
            push({
              k: "size",
              el: label(r.target),
              h,
              dh: h - prev,
              top: watched ? Math.round(watched.scrollTop) : undefined,
              fin: touching || undefined,
            });
            // The container grew: paging or streaming added rows we aren't
            // watching yet. Observing an already-observed row is a no-op.
            if (watched && r.target.parentElement === watched) observeRows();
          }
        })
      : null;
  function observeRows(): void {
    if (!ro || !watched) return;
    const targets = [...Array.from(watched.children), ...Array.from(watched.querySelectorAll(".cm-row-cv"))];
    for (const el of targets) {
      if (observed.has(el)) continue;
      observed.add(el);
      ro.observe(el);
    }
  }
  function watchScroller(el: Element | null): void {
    if (!ro || !el || el === watched) return;
    // Only vertical scrollers with something to scroll — a code block's
    // horizontal `.cm-scroll-x` is not the one whose growth moves the reader.
    if (el.scrollHeight <= el.clientHeight + 1) return;
    ro.disconnect();
    // Fresh map: `observeRows` skips anything already measured, and the old
    // scroller's rows must not count as measured when it becomes the watched
    // one again.
    heights = new WeakMap();
    observed = new WeakSet();
    watched = el;
    scrollerName = describe(el);
    observeRows();
  }
  watchScroller(document.querySelector("[data-transcript]"));
  disposers.push(() => ro?.disconnect());

  // ---- images -------------------------------------------------------------
  // `load`/`error` don't bubble either; capture catches them. `above` is the
  // flag that matters: an image that decodes ABOVE the viewport is the one
  // that pushes the transcript down under the finger.
  const img = (ok: boolean) => (e: Event) => {
    const el = e.target;
    if (!(el instanceof HTMLImageElement)) return;
    const rect = el.getBoundingClientRect();
    const sc = scrollerOf(el);
    const scTop = sc ? sc.getBoundingClientRect().top : 0;
    push({
      k: "img",
      ok,
      w: el.naturalWidth,
      h: el.naturalHeight,
      rh: Math.round(rect.height),
      top: Math.round(rect.top - scTop),
      above: rect.bottom < scTop,
      el: describe(el.parentElement),
      src: el.currentSrc.replace(/^.*\//, "").slice(0, 40),
    });
  };
  on("load", img(true));
  on("error", img(false));

  // ---- focus + viewport ---------------------------------------------------
  on("focusin", (e) => push({ k: "focus", el: describe(e.target) }));
  on("focusout", (e) => push({ k: "blur", el: describe(e.target) }));
  let lastVv = "";
  disposers.push(
    useViewport.subscribe((s) => {
      const key = `${s.inset}|${s.vvHeight}|${s.vvOffsetTop}|${s.innerHeight}`;
      if (key === lastVv) return;
      lastVv = key;
      push({ k: "vv", kb: s.inset, h: s.vvHeight, off: s.vvOffsetTop, inner: s.innerHeight });
    }),
  );

  // Chromium only, but free where it exists and it is exactly the thing.
  try {
    const po = new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as Array<PerformanceEntry & { value?: number }>) {
        push({ k: "shift", v: Math.round((entry.value ?? 0) * 1000) / 1000 });
      }
    });
    po.observe({ type: "layout-shift", buffered: false });
    disposers.push(() => po.disconnect());
  } catch {
    /* not supported — Safari */
  }

  push({ k: "note", text: "trace started" });

  return () => {
    for (const d of disposers.reverse()) d();
    if (publishTimer) clearTimeout(publishTimer);
    publishTimer = 0;
    t0 = 0;
  };
}

/** One entry as a compact line — shared by the overlay tail and the viewer table. */
export function formatEntry(e: TraceEntry): string {
  const s = `${(e.t / 1000).toFixed(2)}s`;
  switch (e.k) {
    case "touch":
      return `${s} touch ${e.p} ${e.x},${e.y}${e.n !== 1 ? ` n${e.n}` : ""}${e.in ? ` in ${e.in}` : ""}${e.prevented ? " PREVENTED" : ""}`;
    case "pcancel":
      return `${s} pointercancel ${e.el}`;
    case "scroll":
      return `${s} scroll ${e.el} top=${e.top}${e.dy !== undefined ? ` dy=${e.dy}` : ""} h=${e.h}${e.fin ? " finger" : ""}${e.prog ? " PROG" : ""}`;
    case "set":
      return `${s} SET ${e.how} ${e.el} → ${e.v} by ${e.by}`;
    case "size":
      return `${s} size ${e.el} ${(e.dh as number) > 0 ? "+" : ""}${e.dh} → ${e.h} @top=${e.top}${e.fin ? " finger" : ""}`;
    case "img":
      return `${s} img ${e.ok ? "load" : "ERROR"} ${e.src} ${e.w}×${e.h} rh=${e.rh} top=${e.top}${e.above ? " ABOVE" : ""}`;
    case "focus":
    case "blur":
      return `${s} ${e.k} ${e.el}`;
    case "vv":
      return `${s} vv kb=${e.kb} h=${e.h} off=${e.off} inner=${e.inner}`;
    case "shift":
      return `${s} layout-shift ${e.v}`;
    case "note":
      return `${s} — ${e.text}`;
    default:
      return `${s} ${e.k}`;
  }
}
