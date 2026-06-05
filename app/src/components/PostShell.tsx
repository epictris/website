import { A, useLocation, useNavigate } from "@solidjs/router";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  type ParentProps,
  Show,
} from "solid-js";
import { mostRecentSlug, posts, postsByDate } from "../content/posts";
import { getTagColor, type Post, TagClickContext } from "./PostPreview";
import { PostReader } from "./PostReader";
import "./PostShell.css";

// ── fzf-style query parsing ──────────────────────────────────────────

type Term = {
  negate: boolean;
  value: string;
  prefix: boolean; // ^
  suffix: boolean; // $
  exact: boolean; // quoted → substring match, not fuzzy
  boundary: boolean; // quoted both ends → word-boundary match
};

function parseQuery(query: string): Term[] {
  const terms: Term[] = [];
  let i = 0;
  while (i < query.length) {
    if (/\s/.test(query[i])) {
      i++;
      continue;
    }

    let negate = false;
    if (query[i] === "!") {
      negate = true;
      i++;
      if (i >= query.length) break;
    }

    let value: string;
    let exact = false;
    let boundary = false;

    if (query[i] === "'") {
      i++; // skip opening quote
      const start = i;
      while (i < query.length && query[i] !== "'") i++;
      value = query.slice(start, i);
      exact = true;
      if (i < query.length && query[i] === "'") {
        boundary = true;
        i++; // skip closing quote
      }
    } else {
      const start = i;
      while (i < query.length && !/\s/.test(query[i]) && query[i] !== "'") i++;
      value = query.slice(start, i);
    }

    if (value === "") continue;

    let prefix = false;
    let suffix = false;
    if (!exact) {
      if (value.startsWith("^")) {
        prefix = true;
        value = value.slice(1);
      }
      if (value.endsWith("$")) {
        suffix = true;
        value = value.slice(0, -1);
      }
    }

    if (value === "") continue;

    terms.push({ negate, value, prefix, suffix, exact, boundary });
  }
  return terms;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Returns true when the term matches the haystack. */
function matchTerm(term: Term, haystack: string): boolean {
  const h = haystack.toLowerCase();
  const v = term.value.toLowerCase();
  let matched: boolean;
  if (term.prefix && term.suffix) {
    matched = h === v;
  } else if (term.prefix) {
    matched = h.startsWith(v);
  } else if (term.suffix) {
    matched = h.endsWith(v);
  } else if (term.boundary) {
    matched = new RegExp(`(?<=^|\\W)${escapeRegex(v)}(?=\\W|$)`, "i").test(h);
  } else if (term.exact) {
    matched = h.includes(v);
  } else {
    matched = fuzzyScore(v, haystack) !== null;
  }
  return term.negate ? !matched : matched;
}

/**
 * All fuzzy terms (non-exact, non-negated) contribute to the sort score.
 * Exact / negated terms are hard filters — they don't affect ranking.
 */
function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (q === "") return 0;
  const t = text.toLowerCase();
  let score = 0;
  let qi = 0;
  let prevMatch = -2;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] !== q[qi]) continue;
    let pts = 1;
    if (prevMatch === i - 1) pts += 5;
    if (i === 0 || /\W/.test(t[i - 1])) pts += 3;
    score += pts;
    prevMatch = i;
    qi++;
  }
  return qi === q.length ? score : null;
}

// ── component ────────────────────────────────────────────────────────

/**
 * The persistent site frame, rendered once at the router root so it survives
 * navigation: a search bar pinned to the top, a reveal-on-focus sidepanel
 * listing every post, and the current route's content as the reader.
 *
 * Selecting a post navigates to it (loading the real page) — on mobile the
 * search pane stays open so you can keep flipping through posts; on desktop the
 * highlighted row is previewed client-side and a click commits + closes.
 */
export function PostShell(props: ParentProps) {
  const location = useLocation();
  const [query, setQuery] = createSignal("");
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  // Open from the very first render on the home page, so the palette is already
  // shown on load — no open-flicker (desktop) or opening animation (mobile).
  const [open, setOpen] = createSignal(location.pathname === "/");
  // Whether the search input genuinely holds focus — drives the blinking
  // cursor, which should only flash while you're actually typing into it.
  const [focused, setFocused] = createSignal(false);
  const [cursorPos, setCursorPos] = createSignal(0);
  const [isNarrow, setIsNarrow] = createSignal(false);
  // Mobile drag-to-open/close: the live list-pane height in px while the user
  // drags (null = use the CSS height), and whether a finger drag is actively
  // tracking (which disables the height transition so it follows 1:1).
  const [dragHeight, setDragHeight] = createSignal<number | null>(null);
  const [dragging, setDragging] = createSignal(false);

  let searchInput: HTMLInputElement | undefined;
  let cursorEl: HTMLSpanElement | undefined;
  let listPanel: HTMLDivElement | undefined;
  let topBar: HTMLLabelElement | undefined;
  let sidepanel: HTMLDivElement | undefined;
  let readerPane: HTMLDivElement | undefined;
  const navigate = useNavigate();

  // The post backing the current route (the home page shows the newest post).
  const activeSlug = createMemo(() => {
    const m = location.pathname.match(/^\/post\/(.+)$/);
    return m ? decodeURIComponent(m[1]) : mostRecentSlug();
  });

  const filtered = createMemo<Post[]>(() => {
    const q = query();
    if (q === "") return postsByDate();

    const terms = parseQuery(q);
    if (terms.length === 0) return postsByDate();

    // Split terms: fuzzy terms drive scoring; exact/negated terms are hard filters.
    const fuzzyTerms = terms.filter((t) => !t.exact && !t.negate);
    const hardTerms = terms.filter((t) => t.exact || t.negate);

    return posts
      .filter((post) => {
        const haystack = `${post.title} ${post.tags.map((t) => `#${t}`).join(" ")} ${post.date}`;
        return hardTerms.every((t) => matchTerm(t, haystack));
      })
      .map((post) => {
        const haystack = `${post.title} ${post.tags.map((t) => `#${t}`).join(" ")} ${post.date}`;
        // Every fuzzy term must match; sum their scores for ranking.
        let score = 0;
        for (const t of fuzzyTerms) {
          const s = fuzzyScore(t.value, haystack);
          if (s === null) return null;
          score += s;
        }
        // Title bonus: fuzzy terms matched against the title get 3x weight.
        let titleBonus = 0;
        for (const t of fuzzyTerms) {
          titleBonus += fuzzyScore(t.value, post.title) ?? 0;
        }
        return { post, score: score + titleBonus * 3 };
      })
      .filter((m): m is { post: Post; score: number } => m !== null)
      .sort((a, b) => b.score - a.score)
      .map((m) => m.post);
  });

  const selectedPost = createMemo(() => filtered()[selectedIndex()]);

  // Desktop client-side preview: show the highlighted row's post in the reader
  // without navigating. Only when it differs from the active route — otherwise
  // we render `props.children` directly, so the reader doesn't remount (and
  // flicker) when `isNarrow` resolves on mount or the selection lands on the
  // post you're already reading.
  const preview = createMemo(() => {
    if (isNarrow() || !open()) return undefined;
    const post = selectedPost();
    return post && post.slug !== activeSlug() ? post : undefined;
  });

  // Keep the highlighted row in view as the selection moves.
  createEffect(() => {
    const idx = selectedIndex();
    const rows = listPanel?.querySelectorAll<HTMLElement>(".post-row");
    rows?.[idx]?.scrollIntoView({ block: "nearest" });
  });

  // Reset the blinking cursor animation whenever it moves, so it starts
  // visible instead of mid-blink.
  createEffect(() => {
    cursorPos();
    if (!cursorEl) return;
    cursorEl.style.animation = "none";
    void cursorEl.offsetHeight; // force reflow
    cursorEl.style.animation = "";
  });

  // Scroll the reader back to the top when the shown post changes — on
  // navigation, or (desktop) as the previewed selection moves. Deliberately
  // not tied to open(), so collapsing the pane on mobile keeps your scroll.
  createEffect(() => {
    activeSlug();
    if (!isNarrow()) selectedIndex();
    if (readerPane) readerPane.scrollTop = 0;
  });

  function openPalette() {
    setOpen(true);
    searchInput?.focus();
    // Start the selection on the post currently being read, if it's listed.
    const idx = filtered().findIndex((p) => p.slug === activeSlug());
    setSelectedIndex(idx === -1 ? 0 : idx);
  }

  function closePalette() {
    setOpen(false);
    setQuery("");
    searchInput?.blur();
    setDragHeight(null);
    setDragging(false);
  }

  // Desktop: open the post and close the palette in one step.
  function select(slug: string) {
    closePalette();
    navigate(`/post/${slug}`);
  }

  onMount(() => {
    const mq = window.matchMedia("(max-width: 800px)");
    setIsNarrow(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setIsNarrow(e.matches);
    mq.addEventListener("change", onChange);
    onCleanup(() => mq.removeEventListener("change", onChange));

    // The home page renders with the palette already open (see the `open`
    // signal). Start the selection on the shown post and, on desktop, focus the
    // input — on mobile we skip focus to avoid popping the keyboard.
    if (location.pathname === "/") {
      const idx = filtered().findIndex((p) => p.slug === activeSlug());
      setSelectedIndex(idx === -1 ? 0 : idx);
      if (!mq.matches) searchInput?.focus();
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (!open()) {
        // "/" or Cmd/Ctrl+K summons the palette from anywhere.
        const typing =
          document.activeElement instanceof HTMLInputElement ||
          document.activeElement instanceof HTMLTextAreaElement;
        if (e.key === "/" && !typing) {
          e.preventDefault();
          openPalette();
        } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
          e.preventDefault();
          openPalette();
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closePalette();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filtered().length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        const post = filtered()[selectedIndex()];
        if (post) select(post.slug);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    onCleanup(() => document.removeEventListener("keydown", handleKeyDown));

    // Desktop: a press outside the search bar / list dismisses the palette.
    // Mobile is handled by the preview-pane drag/tap gesture below instead.
    const handlePointerDown = (e: PointerEvent) => {
      if (!open() || isNarrow()) return;
      const target = e.target as HTMLElement;
      if (topBar?.contains(target) || sidepanel?.contains(target)) return;
      // Tag badges in the reader pane toggle search filters — don't dismiss.
      if (
        e
          .composedPath()
          .some(
            (el) =>
              el instanceof HTMLElement && el.hasAttribute("data-tag-badge"),
          )
      )
        return;
      closePalette();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    onCleanup(() =>
      document.removeEventListener("pointerdown", handlePointerDown),
    );

    // Mobile gestures on the preview pane:
    //  • when the search pane is open, drag up (or tap) to close it;
    //  • when reading a post scrolled to the top, drag down to open it.
    // While dragging, the list pane's height tracks the finger 1:1 (transition
    // off); on release a CSS transition finishes the open/close animation. The
    // shown post is already loaded, so closing never navigates.
    const ANIM_MS = 200;
    const clamp = (v: number, lo: number, hi: number) =>
      Math.max(lo, Math.min(hi, v));
    let startY = 0;
    let lastY = 0;
    let startHeight = 0;
    let openHeight = 0;
    let mode: "close" | "pending-open" | "open" | null = null;
    let animating = false;
    // Whether the finger travelled far enough to count as a drag rather than a
    // tap. A tap on the preview while the list is open dismisses it.
    let moved = false;
    const TAP_SLOP = 8;

    const onReaderTouchStart = (e: TouchEvent) => {
      if (!isNarrow() || animating || !sidepanel) return;
      startY = lastY = e.touches[0].clientY;
      moved = false;
      if (open()) {
        mode = "close";
        startHeight = sidepanel.offsetHeight;
        setDragging(true);
        setDragHeight(startHeight); // freeze for 1:1 tracking
      } else if ((readerPane?.scrollTop ?? 0) <= 0) {
        // Reading at the very top: a downward drag may pull the search pane in.
        mode = "pending-open";
        startHeight = 0;
        openHeight = sidepanel.parentElement
          ? sidepanel.parentElement.clientHeight * 0.5
          : 0;
      } else {
        mode = null;
      }
    };

    const onReaderTouchMove = (e: TouchEvent) => {
      if (mode === null) return;
      const y = e.touches[0].clientY;
      const dy = y - startY; // down is positive
      if (Math.abs(dy) > TAP_SLOP) moved = true;
      if (mode === "pending-open") {
        if (dy <= 0) {
          mode = null;
          return;
        } // scrolling the post up — let it scroll
        if (dy < 8) return; // wait for a deliberate downward drag
        mode = "open";
        setDragging(true);
        const idx = filtered().findIndex((p) => p.slug === activeSlug());
        setSelectedIndex(idx === -1 ? 0 : idx);
      }
      if (mode === "close") {
        // Dragging up collapses the list (its top edge tracks the finger);
        // dragging down is ignored — the list never grows past its open height,
        // so the preview's top edge can't slide down below it.
        const desired = startHeight + Math.min(dy, 0);
        if (desired > 0) {
          setDragHeight(desired); // collapsing the list, top edge tracks the finger
        } else {
          // List fully collapsed: hand the remaining drag to the preview's own
          // scroll so the page keeps moving naturally under the finger.
          if (dragHeight() !== 0) setDragHeight(0);
          if (readerPane) readerPane.scrollTop += lastY - y;
        }
      } else {
        setDragHeight(clamp(dy, 0, openHeight));
      }
      lastY = y;
      e.preventDefault(); // we own the gesture (page scroll is driven manually)
    };

    const onReaderTouchEnd = (e: TouchEvent) => {
      const m = mode;
      mode = null;
      if (m === null || m === "pending-open") {
        setDragHeight(null);
        setDragging(false);
        return;
      }
      e.preventDefault(); // suppress the synthesized click (e.g. links in preview)
      setDragging(false); // enable the transition
      animating = true;
      if (m === "close") {
        const h = dragHeight() ?? startHeight;
        if (h <= 0) {
          closePalette(); // already collapsed into the content — finish now
          animating = false;
        } else if (!moved || h < startHeight * 0.75) {
          // A tap, or dragged up at least a quarter of the way — close.
          requestAnimationFrame(() => setDragHeight(0));
          window.setTimeout(() => {
            closePalette();
            animating = false;
          }, ANIM_MS);
        } else {
          // Didn't drag up far enough, or dragged back down — snap open again.
          requestAnimationFrame(() => setDragHeight(startHeight));
          window.setTimeout(() => {
            setDragHeight(null);
            animating = false;
          }, ANIM_MS);
        }
      } else {
        const h = dragHeight() ?? 0;
        if (h >= openHeight * 0.25) {
          // Dragged down at least a quarter of the way — commit to opening.
          requestAnimationFrame(() => setDragHeight(openHeight));
          window.setTimeout(() => {
            setOpen(true);
            setDragHeight(null);
            animating = false;
          }, ANIM_MS);
        } else {
          // Didn't drag down far enough, or dragged back up — snap closed again.
          requestAnimationFrame(() => setDragHeight(0));
          window.setTimeout(() => {
            setDragHeight(null);
            animating = false;
          }, ANIM_MS);
        }
      }
    };

    readerPane?.addEventListener("touchstart", onReaderTouchStart, {
      passive: true,
    });
    readerPane?.addEventListener("touchmove", onReaderTouchMove, {
      passive: false,
    });
    readerPane?.addEventListener("touchend", onReaderTouchEnd, {
      passive: false,
    });
    onCleanup(() => {
      readerPane?.removeEventListener("touchstart", onReaderTouchStart);
      readerPane?.removeEventListener("touchmove", onReaderTouchMove);
      readerPane?.removeEventListener("touchend", onReaderTouchEnd);
    });
  });

  const onTagClick = (tag: string) => {
    const tagFilter = `'#${tag}'`;
    setQuery((prev) => {
      let next: string;
      if (prev.includes(tagFilter)) {
        // Toggle off: remove the tag filter and clean up whitespace.
        next = prev.replace(tagFilter, "").replace(/\s+/g, " ").trim();
        if (next !== "") next += " ";
      } else {
        // Toggle on: prepend with trailing space for visual separation.
        next = prev === "" ? `${tagFilter} ` : `${tagFilter} ${prev}`;
      }
      setCursorPos(next.length);
      return next;
    });
    // Keep preview on the active post, not the top filtered result.
    const idx = filtered().findIndex((p) => p.slug === activeSlug());
    setSelectedIndex(idx === -1 ? 0 : idx);
    searchInput?.focus();
  };

  return (
    <TagClickContext.Provider value={onTagClick}>
      <main class="shell">
        <div class="h-sep" aria-hidden="true" />
        {/* A <label> natively focuses its nested input on click — no JS or
          keyboard handler needed, and it stays fully accessible. */}
        <label class="top-bar" ref={topBar}>
          <span class="top-prompt" aria-hidden="true">
            ❯
          </span>
          <div class="search-input-area">
            <input
              ref={searchInput}
              type="text"
              class="site-search"
              aria-label="search"
              value={query()}
              onInput={(e) => {
                setQuery(e.currentTarget.value);
                setCursorPos(e.currentTarget.selectionStart ?? 0);
                setSelectedIndex(0);
              }}
              onClick={(e) => setCursorPos(e.currentTarget.selectionStart ?? 0)}
              onKeyUp={(e) => setCursorPos(e.currentTarget.selectionStart ?? 0)}
              onFocus={() => {
                setFocused(true);
                setOpen(true);
              }}
              onBlur={() => setFocused(false)}
            />
            <Show when={focused()}>
              <span
                ref={cursorEl}
                class="block-cursor active"
                style={{ left: `${cursorPos()}ch` }}
                aria-hidden="true"
              >
                █
              </span>
            </Show>
            <Show when={!focused() && query() === ""}>
              <span class="search-hint" aria-hidden="true">
                search <span class="search-hint-key">/</span>
              </span>
            </Show>
          </div>
          <Show when={open()}>
            <span class="post-count">
              {filtered().length}/{posts.length}
            </span>
          </Show>
        </label>

        <div
          class="h-sep h-sep-split"
          classList={{ open: open() }}
          aria-hidden="true"
        />

        <div class="shell-body">
          <div
            class="sidepanel"
            classList={{ open: open(), dragging: dragging() }}
            style={
              dragHeight() !== null
                ? { height: `${dragHeight()}px` }
                : undefined
            }
            ref={sidepanel}
          >
            <div class="post-list-panel" ref={listPanel}>
              <For each={filtered()}>
                {(post, i) => (
                  <A
                    href={`/post/${post.slug}`}
                    class="post-row"
                    classList={{
                      selected: i() === selectedIndex(),
                      active: post.slug === activeSlug(),
                    }}
                    onMouseMove={() => {
                      if (!isNarrow()) setSelectedIndex(i());
                    }}
                    onClick={(e) => {
                      if (e.metaKey || e.ctrlKey || e.shiftKey) return;
                      e.preventDefault();
                      if (isNarrow()) {
                        // Mobile: load the page but keep the search pane open.
                        setSelectedIndex(i());
                        navigate(`/post/${post.slug}`);
                      } else {
                        select(post.slug); // desktop: open the post and close
                      }
                    }}
                  >
                    <span class="row-indicator" aria-hidden="true">
                      {i() === selectedIndex() ? "▌" : ""}
                    </span>
                    <span class="row-number">
                      {(i() + 1).toString().padStart(2, "0")}
                    </span>
                    <span class="row-title">{post.title}</span>
                    <span class="row-tags">
                      <For each={post.tags}>
                        {(tag) => (
                          <>
                            {/* biome-ignore lint/a11y/noStaticElementInteractions: tag fits inline in result row */}
                            {/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard nav via search input */}
                            <span
                              class="row-tag"
                              style={{ color: getTagColor(tag) }}
                              onClick={(e) => {
                                e.stopPropagation();
                                e.preventDefault();
                                onTagClick(tag);
                              }}
                            >
                              #{tag}
                            </span>
                          </>
                        )}
                      </For>
                    </span>
                    <span class="row-date">{post.date}</span>
                  </A>
                )}
              </For>
              <Show when={filtered().length === 0}>
                <p class="no-results">no matching posts found</p>
              </Show>
            </div>
            <div class="shell-divider" aria-hidden="true" />
          </div>

          <div class="reader-pane" ref={readerPane}>
            {/* Desktop previews the highlighted row client-side when it differs
              from the active route; otherwise we show the loaded route. */}
            <Show when={preview()} fallback={props.children}>
              {(post) => <PostReader post={post()} />}
            </Show>
          </div>
        </div>
      </main>
    </TagClickContext.Provider>
  );
}
