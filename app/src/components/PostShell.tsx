import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { A, useNavigate } from "@solidjs/router";
import { getTagColor, type Post } from "./PostPreview";
import { PostReader } from "./PostReader";
import { posts, postsByDate, getPost } from "../content/posts";
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
 * The site frame: a search bar pinned to the top on every page, a
 * reveal-on-focus sidepanel that lists every post for rapid switching, and the
 * full content of `activeSlug` as the main reader. Selecting a post navigates
 * client-side (instant) and collapses the palette.
 */
export function PostShell(props: { activeSlug: string; defaultOpen?: boolean }) {
  const [query, setQuery] = createSignal("");
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  const [open, setOpen] = createSignal(false);
  const [isNarrow, setIsNarrow] = createSignal(false);

  let searchInput: HTMLInputElement | undefined;
  let listPanel: HTMLDivElement | undefined;
  let topBar: HTMLDivElement | undefined;
  let sidepanel: HTMLDivElement | undefined;
  const navigate = useNavigate();

  const activePost = createMemo(() => getPost(props.activeSlug));

  // While the palette is open the reader previews the highlighted row, so
  // arrowing/hovering through the list live-updates the content. Closed, it
  // shows the post for the current route.
  const displayedPost = createMemo(() => {
    if (open()) {
      const selected = filtered()[selectedIndex()];
      if (selected) return selected;
    }
    return activePost();
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

  function openPalette() {
    setOpen(true);
    searchInput?.focus();
    // Start the selection on the post currently being read, if it's listed.
    const idx = filtered().findIndex(p => p.slug === props.activeSlug);
    setSelectedIndex(idx === -1 ? 0 : idx);
  }

  function closePalette() {
    setOpen(false);
    setQuery("");
    searchInput?.blur();
  }

  function select(slug: string) {
    closePalette();
    navigate(`/post/${slug}`);
  }

  onMount(() => {
    const mq = window.matchMedia("(max-width: 768px)");
    setIsNarrow(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setIsNarrow(e.matches);
    mq.addEventListener("change", onChange);
    onCleanup(() => mq.removeEventListener("change", onChange));

    // Land with the palette already open (the home/search experience). On
    // mobile we reveal it without focusing the input, to avoid the keyboard.
    if (props.defaultOpen) {
      setOpen(true);
      const idx = filtered().findIndex(p => p.slug === props.activeSlug);
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

    // Clicking outside the search bar / list dismisses the palette.
    const handlePointerDown = (e: PointerEvent) => {
      if (!open()) return;
      const target = e.target as Node;
      if (topBar?.contains(target) || sidepanel?.contains(target)) return;
      closePalette();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    onCleanup(() => document.removeEventListener("pointerdown", handlePointerDown));
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
            onFocus={() => setOpen(true)}
          />
          <Show when={open()}>
            <span
              class="block-cursor active"
              style={{ left: `${query().length}ch` }}
              aria-hidden="true"
            >█</span>
          </Show>
          <Show when={!open() && query() === ""}>
            <span class="search-hint" aria-hidden="true">
              search <span class="search-hint-key">/</span>
            </span>
          </Show>
        </div>
        <Show when={open()}>
          <span class="post-count">{filtered().length}/{posts.length}</span>
        </Show>
      </div>

      <div class="h-sep" aria-hidden="true" />

      <div class="shell-body">
        <div class="sidepanel" classList={{ open: open() }} ref={sidepanel}>
          <div class="post-list-panel" ref={listPanel}>
            <For each={filtered()}>
              {(post, i) => (
                <A
                  href={`/post/${post.slug}`}
                  class="post-row"
                  classList={{
                    selected: i() === selectedIndex(),
                    active: post.slug === props.activeSlug,
                  }}
                  onMouseMove={() => { if (!isNarrow()) setSelectedIndex(i()); }}
                  onClick={e => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey) return;
                    e.preventDefault();
                    select(post.slug);
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
        </div>

        <div class="reader-pane">
          <Show when={displayedPost()}>
            {post => <PostReader post={post()} />}
          </Show>
        </div>
      </div>
    </main>
  );
}
