import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount, type ParentProps } from "solid-js";
import { A, useLocation, useNavigate } from "@solidjs/router";
import { getTagColor, type Post } from "./PostPreview";
import { PostReader } from "./PostReader";
import { posts, postsByDate, getPost, mostRecentSlug } from "../content/posts";
import "./PostShell.css";

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
  const [isNarrow, setIsNarrow] = createSignal(false);
  // Mobile drag-to-open/close: the live list-pane height in px while the user
  // drags (null = use the CSS height), and whether a finger drag is actively
  // tracking (which disables the height transition so it follows 1:1).
  const [dragHeight, setDragHeight] = createSignal<number | null>(null);
  const [dragging, setDragging] = createSignal(false);

  let searchInput: HTMLInputElement | undefined;
  let listPanel: HTMLDivElement | undefined;
  let topBar: HTMLDivElement | undefined;
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
    return posts
      .map(post => {
        const haystack = `${post.title} ${post.desc} ${post.tags.join(" ")}`;
        const haystackScore = fuzzyScore(q, haystack);
        if (haystackScore === null) return null;
        const titleScore = fuzzyScore(q, post.title) ?? 0;
        return { post, score: haystackScore + titleScore * 3 };
      })
      .filter((m): m is { post: Post; score: number } => m !== null)
      .sort((a, b) => b.score - a.score)
      .map(m => m.post);
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

  // Reset selection to the top whenever the result set changes.
  createEffect(() => {
    filtered();
    setSelectedIndex(0);
  });

  // Keep the highlighted row in view as the selection moves.
  createEffect(() => {
    const idx = selectedIndex();
    const rows = listPanel?.querySelectorAll<HTMLElement>(".post-row");
    rows?.[idx]?.scrollIntoView({ block: "nearest" });
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
    const idx = filtered().findIndex(p => p.slug === activeSlug());
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
      const idx = filtered().findIndex(p => p.slug === activeSlug());
      setSelectedIndex(idx === -1 ? 0 : idx);
      if (!mq.matches) searchInput?.focus();
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (!open()) {
        // "/" or Cmd/Ctrl+K summons the palette from anywhere.
        const typing = document.activeElement instanceof HTMLInputElement
          || document.activeElement instanceof HTMLTextAreaElement;
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
        setSelectedIndex(i => Math.min(i + 1, filtered().length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex(i => Math.max(i - 1, 0));
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
      const target = e.target as Node;
      if (topBar?.contains(target) || sidepanel?.contains(target)) return;
      closePalette();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    onCleanup(() => document.removeEventListener("pointerdown", handlePointerDown));

    // Mobile gestures on the preview pane:
    //  • when the search pane is open, drag up (or tap) to close it;
    //  • when reading a post scrolled to the top, drag down to open it.
    // While dragging, the list pane's height tracks the finger 1:1 (transition
    // off); on release a CSS transition finishes the open/close animation. The
    // shown post is already loaded, so closing never navigates.
    const ANIM_MS = 200;
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
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
        openHeight = sidepanel.parentElement ? sidepanel.parentElement.clientHeight * 0.5 : 0;
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
        if (dy <= 0) { mode = null; return; } // scrolling the post up — let it scroll
        if (dy < 8) return; // wait for a deliberate downward drag
        mode = "open";
        setDragging(true);
        const idx = filtered().findIndex(p => p.slug === activeSlug());
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
          window.setTimeout(() => { closePalette(); animating = false; }, ANIM_MS);
        } else {
          // Didn't drag up far enough, or dragged back down — snap open again.
          requestAnimationFrame(() => setDragHeight(startHeight));
          window.setTimeout(() => { setDragHeight(null); animating = false; }, ANIM_MS);
        }
      } else {
        const h = dragHeight() ?? 0;
        if (h >= openHeight * 0.25) {
          // Dragged down at least a quarter of the way — commit to opening.
          requestAnimationFrame(() => setDragHeight(openHeight));
          window.setTimeout(() => { setOpen(true); setDragHeight(null); animating = false; }, ANIM_MS);
        } else {
          // Didn't drag down far enough, or dragged back up — snap closed again.
          requestAnimationFrame(() => setDragHeight(0));
          window.setTimeout(() => { setDragHeight(null); animating = false; }, ANIM_MS);
        }
      }
    };

    readerPane?.addEventListener("touchstart", onReaderTouchStart, { passive: true });
    readerPane?.addEventListener("touchmove", onReaderTouchMove, { passive: false });
    readerPane?.addEventListener("touchend", onReaderTouchEnd, { passive: false });
    onCleanup(() => {
      readerPane?.removeEventListener("touchstart", onReaderTouchStart);
      readerPane?.removeEventListener("touchmove", onReaderTouchMove);
      readerPane?.removeEventListener("touchend", onReaderTouchEnd);
    });
  });

  return (
    <main class="shell">
      <div class="h-sep" aria-hidden="true" />
      <div
        class="top-bar"
        ref={topBar}
        onClick={() => searchInput?.focus()}
      >
        <span class="top-prompt" aria-hidden="true">❯</span>
        <div class="search-input-area">
          <input
            ref={searchInput}
            type="text"
            class="site-search"
            aria-label="search"
            value={query()}
            onInput={e => setQuery(e.currentTarget.value)}
            onFocus={() => { setFocused(true); setOpen(true); }}
            onBlur={() => setFocused(false)}
          />
          <Show when={focused()}>
            <span
              class="block-cursor active"
              style={{ left: `${query().length}ch` }}
              aria-hidden="true"
            >█</span>
          </Show>
          <Show when={!focused() && query() === ""}>
            <span class="search-hint" aria-hidden="true">
              search <span class="search-hint-key">/</span>
            </span>
          </Show>
        </div>
        <Show when={open()}>
          <span class="post-count">{filtered().length}/{posts.length}</span>
        </Show>
      </div>

      <div class="h-sep h-sep-split" classList={{ open: open() }} aria-hidden="true" />

      <div class="shell-body">
        <div
          class="sidepanel"
          classList={{ open: open(), dragging: dragging() }}
          style={dragHeight() !== null ? { height: `${dragHeight()}px` } : undefined}
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
                  onMouseMove={() => { if (!isNarrow()) setSelectedIndex(i()); }}
                  onClick={e => {
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
                  <span class="row-indicator" aria-hidden="true">{i() === selectedIndex() ? "▌" : ""}</span>
                  <span class="row-number">{(i() + 1).toString().padStart(2, "0")}</span>
                  <span class="row-title">{post.title}</span>
                  <span class="row-tags">
                    <For each={post.tags}>
                      {tag => <span class="row-tag" style={{ color: getTagColor(tag) }}>#{tag}</span>}
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
            {post => <PostReader post={post()} />}
          </Show>
        </div>
      </div>
    </main>
  );
}
