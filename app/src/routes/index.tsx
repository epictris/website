import { Title } from "@solidjs/meta";
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { A } from "@solidjs/router";
import "./index.css";

const GitHubIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z"/>
  </svg>
);

const LinkedInIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/>
  </svg>
);

type Post = {
  slug: string;
  title: string;
  desc: string;
  tags: string[];
};

const tagColors: Record<string, string> = {
  meta: "#95e6cb",
  tooling: "#ffd580",
  lsp: "#73d0ff",
  networking: "#bae67e",
  web: "#d4bfff",
};

const posts: Post[] = [
  {
    slug: "hello-world",
    title: "Hello, world",
    desc: "An introduction to this site and what I plan to write about",
    tags: ["meta"],
  },
  {
    slug: "pattern-matching-lsp",
    title: "Pattern-matching LSP",
    desc: "A language-agnostic LSP implementation based on regex pattern matching",
    tags: ["lsp", "tooling"],
  },
  {
    slug: "online-clipboard",
    title: "Websocket clipboard",
    desc: "An online clipboard sharing application leveraging shared websocket sessions",
    tags: ["networking", "web"],
  },
  {
    slug: "clocks",
    title: "Text clocks",
    desc: "Designing and manufacturing clocks that use natural-language to display time",
    tags: [],
  },
  {
    slug: "grappling-hook-game",
    title: "2D grappling hook game",
    desc: "My custom implementation of 2D grappling hook physics",
    tags: [],
  },
  {
    slug: "python-orm",
    title: "Type-safe Python query builder",
    desc: "A fully type-safe interface for dynamically building & validating complex query payloads",
    tags: ["tooling"],
  },
  {
    slug: "dnd-character-sheet",
    title: "Obsidian canvas character sheet template",
    desc: "A character sheet I made using Obsidian's Canvas feature.",
    tags: [],
  },
  {
    slug: "garmin-watch-face",
    title: "Garmin watch face",
    desc: "A custom watch face I developed for my garmin watch",
    tags: [],
  },
  {
    slug: "8ball-pool",
    title: "8-ball pool",
    desc: "A realtime 8-ball pool game I made",
    tags: ["networking", "web"],
  },
  {
    slug: "keyboard-layout",
    title: "Custom keyboard layout",
    desc: "How I designed my own keyboard layout",
    tags: ["tooling"],
  },
  {
    slug: "nvim-config",
    title: "My neovim config",
    desc: "Thoughts on the design and implementation of my neovim config",
    tags: ["tooling", "lsp"],
  },
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

const allTags = [...new Set(posts.flatMap((post) => post.tags))];

const banner = String.raw` ╭─╮      ╭─╮           ╭─╮
╭╯ ╰─┬─┬──┼─┼───╮   ╭───┤ └──╮
╰╮ ╭─┤ ╭──┤ │ ──┤   │ ──┤ ╭╮ │
 │ │ │ │  │ ├── │╭─╮├── │ ││ │
 ╰─╯ ╰─╯  ╰─┴───╯╰─╯╰───┴─╯╰─╯
`;

export default function Home() {
  const [query, setQuery] = createSignal("");
  const [selectedTags, setSelectedTags] = createSignal<string[]>([]);
  const [filterOpen, setFilterOpen] = createSignal(false);
  const [focused, setFocused] = createSignal(false);
  let searchInput: HTMLInputElement | undefined;
  let wrapperEl: HTMLDivElement | undefined;

  onMount(() => {
    searchInput?.focus();
    const handleClick = (e: MouseEvent) => {
      if (!e.composedPath().includes(wrapperEl!)) {
        setFilterOpen(false);
      }
    };
    document.addEventListener("click", handleClick);
    onCleanup(() => document.removeEventListener("click", handleClick));
  });

  const addTag = (tag: string) =>
    setSelectedTags((prev) => [...prev, tag]);

  const removeTag = (tag: string) =>
    setSelectedTags((prev) => prev.filter((t) => t !== tag));

  const availableTags = createMemo(() =>
    allTags.filter((t) => !selectedTags().includes(t)),
  );

  const filtered = createMemo(() => {
    const q = query();
    const tags = selectedTags();
    return posts
      .filter((post) => tags.length === 0 || tags.every((t) => post.tags.includes(t)))
      .map((post) => {
        const haystackScore = fuzzyScore(q, `${post.title} ${post.desc}`);
        if (haystackScore === null) return null;
        const titleScore = fuzzyScore(q, post.title) ?? 0;
        return { post, score: haystackScore + titleScore * 3 };
      })
      .filter((m): m is { post: Post; score: number } => m !== null)
      .sort((a, b) => b.score - a.score)
      .map((m) => m.post);
  });

  return (
    <main class="page">
      <Title>tris.sh</Title>

      <nav class="site-nav" aria-label="Social links">
        <a href="https://github.com/epictris" target="_blank" rel="noopener noreferrer" aria-label="GitHub">
          <GitHubIcon />
        </a>
        <a href="https://www.linkedin.com/in/tristan-bray-638b89214/" target="_blank" rel="noopener noreferrer" aria-label="LinkedIn">
          <LinkedInIcon />
        </a>
      </nav>

      <div class="banner" aria-hidden="true">{banner}</div>

      <div class="search-wrapper" ref={wrapperEl}>
        <header box-="square" class="site-header">
          <div class="search-row">
            <span class="search-prompt" aria-hidden="true">❯</span>
            <div class="search-input-area">
              <input
                ref={searchInput}
                type="text"
                class="site-search"
                placeholder={""}
                aria-label="Search posts"
                value={query()}
                onInput={(e) => setQuery(e.currentTarget.value)}
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
            <button
              type="button"
              class="filter-btn"
              classList={{ active: selectedTags().length > 0 }}
              onClick={() => setFilterOpen((p) => !p)}
              aria-expanded={filterOpen()}
              aria-label="Filter by tag"
            >
              [tags]
            </button>
          </div>

          <Show when={selectedTags().length > 0}>
            <div class="selected-tags-bar">
              <For each={selectedTags()}>
                {(tag) => (
                  <span
                    is-="badge"
                    cap-="round"
                    role="button"
                    tabindex="0"
                    class="active-tag"
                    style={{ "--badge-color": tagColors[tag] ?? "#cbccc6", "--badge-text": "#1f2430" }}
                    onClick={() => removeTag(tag)}
                    onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && removeTag(tag)}
                    aria-label={`Remove ${tag} filter`}
                  >
                    {tag}
                  </span>
                )}
              </For>
            </div>
          </Show>
        </header>

        <Show when={filterOpen()}>
          <div class="filter-dropdown" box-="square">
            <For each={availableTags()}>
              {(tag) => (
                <button
                  type="button"
                  class="available-tag"
                  style={{ "--tag-color": tagColors[tag] ?? "#cbccc6" }}
                  onClick={() => addTag(tag)}
                >
                  {tag}
                </button>
              )}
            </For>
            <Show when={availableTags().length === 0}>
              <span class="no-available-tags">all tags selected</span>
            </Show>
          </div>
        </Show>
      </div>

      <div class="content-section">
        <div class="post-list">
          <For each={filtered()}>
            {(post) => (
              <A href={`/blog/${post.slug}`} class="post-card" box-="square">
                <span class="post-title">{post.title}</span>
                <span class="post-desc">{post.desc}</span>
                <span class="post-tags">
                  <For each={post.tags}>
                    {(tag) => (
                      <span
                        is-="badge"
                        cap-="round"
                        class="post-tag"
                        style={{
                          "--badge-color": tagColors[tag] ?? "#cbccc6",
                          "--badge-text": "#1f2430",
                        }}
                      >
                        {tag}
                      </span>
                    )}
                  </For>
                </span>
              </A>
            )}
          </For>
          <Show when={filtered().length === 0}>
            <p class="no-results">no matching posts found</p>
          </Show>
        </div>
      </div>
    </main>
  );
}
