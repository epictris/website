import { Title } from "@solidjs/meta";
import { Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { A, useNavigate } from "@solidjs/router";
import { PostPreview, Tag, getTagColor, type Post } from "../components/PostPreview";
import "./index.css";

const posts: Post[] = [
  { slug: "nvim-config",                   title: "My neovim config",                   desc: "Thoughts on the design and implementation of my neovim config",                   tags: [Tag.tooling],               date: "2025-11-18", reading: 10 },
  { slug: "keyboard-layout",              title: "Custom keyboard layout",              desc: "How I designed my own keyboard layout",                                           tags: [Tag.tooling],               date: "2025-12-02", reading: 8  },
  { slug: "8ball-pool",                    title: "8-ball pool",                        desc: "A realtime 8-ball pool game I made",                                              tags: [Tag.web, Tag.game],         date: "2025-12-20", reading: 6  },
  { slug: "garmin-watch-face",             title: "Garmin watch face",                  desc: "A custom watch face I developed for my Garmin watch",                             tags: [Tag.project],               date: "2026-01-15", reading: 5  },
  { slug: "dnd-character-sheet",           title: "Obsidian canvas character sheet",    desc: "A character sheet I made using Obsidian's Canvas feature",                        tags: [Tag.project],               date: "2026-02-01", reading: 4  },
  { slug: "python-orm",                    title: "Python query builder",               desc: "A type-safe interface for building & validating complex query payloads",           tags: [Tag.tooling, Tag.project],  date: "2026-02-18", reading: 6  },
  { slug: "grappling-hook-game",           title: "2D grappling hook game",             desc: "My custom implementation of 2D grappling hook physics",                           tags: [Tag.game, Tag.project],     date: "2026-03-05", reading: 5  },
  { slug: "clocks",                        title: "Text clocks",                         desc: "Designing and manufacturing clocks that use natural-language to display time",     tags: [Tag.project],               date: "2026-03-22", reading: 7  },
  { slug: "online-clipboard",              title: "Websocket clipboard",                 desc: "An online clipboard sharing application leveraging shared websocket sessions",     tags: [Tag.web, Tag.project],      date: "2026-04-10", reading: 5  },
  { slug: "pattern-matching-lsp",          title: "Pattern-matching LSP",               desc: "A language-agnostic LSP implementation based on regex pattern matching",           tags: [Tag.tooling, Tag.project],  date: "2026-04-28", reading: 8  },
  { slug: "my-terminal-addiction",      title: "My terminal addiction",           desc: "I tried fzf one time and I've been chasing that high ever since",        tags: [Tag.tooling, Tag.workflow], date: "2026-05-29", reading: 6  },
];

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

export default function Home() {
  const [query, setQuery] = createSignal("");
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  const [focused, setFocused] = createSignal(false);
  const [isNarrow, setIsNarrow] = createSignal(false);

  let searchInput: HTMLInputElement | undefined;
  let listPanel: HTMLDivElement | undefined;
  const navigate = useNavigate();

  onMount(() => {
    searchInput?.focus();

    const mq = window.matchMedia("(max-width: 768px)");
    setIsNarrow(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setIsNarrow(e.matches);
    mq.addEventListener("change", onChange);
    onCleanup(() => mq.removeEventListener("change", onChange));

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex(i => Math.min(i + 1, filtered().length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex(i => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        const post = filtered()[selectedIndex()];
        if (post) navigate(`/post/${post.slug}`);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    onCleanup(() => document.removeEventListener("keydown", handleKeyDown));
  });

  const filtered = createMemo(() => {
    const q = query();
    if (q === "") {
      return [...posts].sort((a, b) => b.date.localeCompare(a.date));
    }
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

  createEffect(() => {
    filtered();
    setSelectedIndex(0);
  });

  createEffect(() => {
    const idx  = selectedIndex();
    const rows = listPanel?.querySelectorAll<HTMLElement>(".post-row");
    rows?.[idx]?.scrollIntoView({ block: "nearest" });
  });

  const selectedPost = createMemo(() => filtered()[selectedIndex()]);

  return (
    <main class="page">
      <Title>tris.sh</Title>

      <div class="h-sep" aria-hidden="true" />
      <A href="/" class="site-title-bar">tris.sh</A>
      <div class="h-sep h-sep-vline" aria-hidden="true" />

      <div class="split-view">
        <div class="left-column">
          <div class="top-bar">
            <div class="top-bar-left">
              <span class="top-prompt" aria-hidden="true">❯</span>
              <span class="top-number-spacer" aria-hidden="true" />
              <div class="search-input-area">
                <input
                  ref={searchInput}
                  type="text"
                  class="site-search"
                  aria-label="Search posts"
                  value={query()}
                  onInput={e => setQuery(e.currentTarget.value)}
                  onFocus={() => setFocused(true)}
                  onBlur={() => setFocused(false)}
                />
                <span
                  class="block-cursor"
                  classList={{ active: focused() }}
                  style={{ left: `${query().length}ch` }}
                  aria-hidden="true"
                >█</span>
              </div>
            </div>
            <div class="top-bar-right">
              <span class="post-count">{filtered().length}/{posts.length}</span>
            </div>
          </div>
          <div class="h-sep" aria-hidden="true" />
          <div class="post-list-panel" ref={listPanel}>
            <For each={filtered()}>
              {(post, i) => (
                <A
                  href={`/post/${post.slug}`}
                  class="post-row"
                  classList={{ selected: i() === selectedIndex() }}
                  onMouseEnter={() => { if (!isNarrow()) setSelectedIndex(i()); }}
                  onClick={e => {
                    // On mobile, tapping a row reveals its inline preview; the
                    // open icon (below) is the only way to navigate to the post
                    if (isNarrow()) {
                      e.preventDefault();
                      setSelectedIndex(i());
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
                  <span
                    class="row-open"
                    role="button"
                    aria-label={`Open ${post.title}`}
                    onClick={e => {
                      e.preventDefault();
                      e.stopPropagation();
                      navigate(`/post/${post.slug}`);
                    }}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <polyline points="9 6 15 12 9 18" />
                    </svg>
                  </span>
                  <div class="row-preview">
                    <Show when={i() === selectedIndex()}>
                      <PostPreview post={post} />
                    </Show>
                  </div>
                </A>
              )}
            </For>
            <Show when={filtered().length === 0}>
              <p class="no-results">no matching posts found</p>
            </Show>
          </div>
        </div>

        <div class="preview-panel">
          <Show when={selectedPost()}>
            {post => <PostPreview post={post()} />}
          </Show>
        </div>
      </div>
    </main>
  );
}
