import { Title } from "@solidjs/meta";
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { A } from "@solidjs/router";
import "./index.css";

type Post = {
  slug: string;
  title: string;
  desc: string;
  tags: Tag[];
};

const GetTagColor: (tag: Tag) => string = (tag: Tag) => {
  switch (tag) {
    case Tag.tooling:
      return "#ffd580";
    case Tag.project:
      return "#bae67e";
    case Tag.web:
      return "#d4bfff";
    case Tag.game:
      return "#ff9f94";
    case Tag.workflow:
      return "#dcabff";
  }
}

const enum Tag {
  tooling = "tooling",
  project = "project",
  web = "web",
  game = "game",
  workflow = "workflow",
};

const posts: Post[] = [
  {
    slug: "learning-to-love-the-cli",
    title: "Learning to love the CLI",
    desc: "How learning to love command line interfaces improved my ability to focus and write good code",
    tags:  [Tag.tooling, Tag.workflow],
  },
  // {
  //   slug: "pattern-matching-lsp",
  //   title: "Pattern-matching LSP",
  //   desc: "A language-agnostic LSP implementation based on regex pattern matching",
  //   tags: [Tag.tooling, Tag.project],
  // },
  // {
  //   slug: "online-clipboard",
  //   title: "Websocket clipboard",
  //   desc: "An online clipboard sharing application leveraging shared websocket sessions",
  //   tags: [Tag.web, Tag.project],
  // },
  // {
  //   slug: "clocks",
  //   title: "Text clocks",
  //   desc: "Designing and manufacturing clocks that use natural-language to display time",
  //   tags: [Tag.project],
  // },
  // {
  //   slug: "grappling-hook-game",
  //   title: "2D grappling hook game",
  //   desc: "My custom implementation of 2D grappling hook physics",
  //   tags: [Tag.game, Tag.project],
  // },
  // {
  //   slug: "python-orm",
  //   title: "Python query builder",
  //   desc: "A type-safe interface for building & validating complex query payloads",
  //   tags: [Tag.tooling, Tag.project],
  // },
  // {
  //   slug: "dnd-character-sheet",
  //   title: "Obsidian canvas character sheet",
  //   desc: "A character sheet I made using Obsidian's Canvas feature.",
  //   tags: [Tag.project],
  // },
  // {
  //   slug: "garmin-watch-face",
  //   title: "Garmin watch face",
  //   desc: "A custom watch face I developed for my garmin watch",
  //   tags: [Tag.project],
  // },
  // {
  //   slug: "8ball-pool",
  //   title: "8-ball pool",
  //   desc: "A realtime 8-ball pool game I made",
  //   tags: [ Tag.web, Tag.game],
  // },
  // {
  //   slug: "keyboard-layout",
  //   title: "Custom keyboard layout",
  //   desc: "How I designed my own keyboard layout",
  //   tags: [Tag.tooling],
  // },
  // {
  //   slug: "nvim-config",
  //   title: "My neovim config",
  //   desc: "Thoughts on the design and implementation of my neovim config",
  //   tags: [  Tag.tooling],
  // },
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

export default function Home() {
  const [query, setQuery] = createSignal("");
  const [selectedTags, setSelectedTags] = createSignal<Tag[]>([]);
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

  const addTag = (tag: Tag) =>
    setSelectedTags((prev) => [...prev, tag]);

  const removeTag = (tag: Tag) =>
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
                    style={{ "--badge-color": GetTagColor(tag) ?? "#cbccc6", "--badge-text": "#1f2430" }}
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
                  style={{ "--tag-color": GetTagColor(tag) ?? "#cbccc6" }}
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
              <A href={`/p/${post.slug}`} class="post-card" box-="square">
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
                          "--badge-color": GetTagColor(tag) ?? "#cbccc6",
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
