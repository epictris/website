import { CodeBlock } from "../components/CodeBlock";
import { type Post, Tag } from "../components/PostPreview";

// ── Post bodies ─────────────────────────────────────────────
// Each written post gets a body component here and is attached to its entry in
// `posts` below. Posts without a body fall back to the snapshot card.

function MyTerminalAddictionBody() {
  return (
    <>
      <p>
        I never understood people who favoured command line interfaces (CLIs)
        over graphical user interfaces (GUIs). Command line syntax felt to me
        like an archaic artifact of legacy technology where even simple
        operations were cumbersome and error-prone. In my limited experience,
        I'd always struggled to build a mental model of the file system I was
        working with - perhaps the CLI required mental visualisation abilities I
        simply did not possess.
        <br />
        <br />
      </p>
      <h2>
        <span class="preview-title-hash">##</span> A catalyst for change
      </h2>
      <p>
        My first software engineering role had me frequently context switching
        between multiple codebases. I'd open the file browser, click through to
        the target directory, wait for my IDE to switch workspaces and
        reinitialize extensions in the new directory, then continue my work.
        Then I'd switch back to my original task and hope I still remembered
        what I'd been working on. ~15 seconds of downtime doesn't sound like a
        lot - but if I'm just checking a value or jotting down a quick note, it
        feels like an eternity. I hated feeling constrained by my tools.
        <br />
        <br />
        I'd seen some crazy workflows online with people flying around their
        terminal environment, searching/editing files and running commands so
        quickly I'd lose track of what was happening. I wanted this speed and
        precision, but every time I tried to use vim for some quick text
        editing, I'd end up fighting against the CLI and waste more time than if
        I'd just done things the normal way.
      </p>
      <br />
      <h2>
        <span class="preview-title-hash">##</span> A breakthrough
      </h2>
      <p>
        I came across fzf - a command-line fuzzy finder. It lets you run a fuzzy
        search over any input data, then prints the selected result. Not
        particularly useful in isolation, but I realised that I could combine it
        with other commands to solve my two biggest pain points:
      </p>
      <br />
      <ol>
        <li>Navigating to a specific directory (quickly)</li>
        <li>Opening a specific file somewhere in that directory (quickly)</li>
      </ol>
      <br />
      <h2>
        <span class="preview-title-hash">###</span> Rapid directory navigation
      </h2>
      <ul>
        <li>Define a list of all frequented directories</li>
        <li>
          Pipe the list to <code>fzf</code>
        </li>
        <li>
          <code>cd</code> to the selected directory
        </li>
      </ul>
      <br />
      <p>
        <i>
          With this terminal alias, I can navigate to any of these directories
          in less than a second with just a few keystrokes
        </i>
        .
        <CodeBlock
          code={`DIRS=$(cat << ---
~/.config/nvim
~/.config/tmux
~/.dotfiles
~/Downloads
~/projects/command-reference
~/projects/website
~/repos/example
---
)
alias d='dir=$(echo $DIRS | fzf) && eval cd $dir'`}
        />
      </p>
      <br />
      <h2>
        <span class="preview-title-hash">###</span> Rapid file search
      </h2>
      <ul>
        <li>
          Use <code>rg</code> (ripgrep) to list all file paths in the current
          directory
        </li>
        <li>
          Pipe the list to <code>fzf</code>
        </li>
        <li>
          Open the selected file in <code>nvim</code>
        </li>
      </ul>
      <br />
      <p>
        <i>
          With this terminal alias, I can open any file in seconds with just a
          few keystrokes
        </i>
      </p>
      <CodeBlock
        code={`alias s='file=$(rg --files | colrm 1 2 | fzf) && nvim $file'`}
      />
      <br />
    </>
  );
}

// ── Registry ────────────────────────────────────────────────

export const posts: Post[] = [
  {
    slug: "nvim-config",
    title: "My neovim config",
    desc: "Thoughts on the design and implementation of my neovim config",
    tags: [Tag.tooling],
    date: "2025-11-18",
    reading: 10,
  },
  {
    slug: "keyboard-layout",
    title: "Custom keyboard layout",
    desc: "How I designed my own keyboard layout",
    tags: [Tag.tooling],
    date: "2025-12-02",
    reading: 8,
  },
  {
    slug: "8ball-pool",
    title: "8-ball pool",
    desc: "A realtime 8-ball pool game I made",
    tags: [Tag.web, Tag.game],
    date: "2025-12-20",
    reading: 6,
  },
  {
    slug: "garmin-watch-face",
    title: "Garmin watch face",
    desc: "A custom watch face I developed for my Garmin watch",
    tags: [Tag.project],
    date: "2026-01-15",
    reading: 5,
  },
  {
    slug: "dnd-character-sheet",
    title: "DnD character sheet",
    desc: "A character sheet I made using Obsidian's Canvas feature",
    tags: [Tag.project],
    date: "2026-02-01",
    reading: 4,
  },
  {
    slug: "python-orm",
    title: "Python query builder",
    desc: "A type-safe interface for building & validating complex query payloads",
    tags: [Tag.tooling, Tag.project],
    date: "2026-02-18",
    reading: 6,
  },
  {
    slug: "grappling-hook-game",
    title: "2D grappling hook game",
    desc: "My custom implementation of 2D grappling hook physics",
    tags: [Tag.game, Tag.project],
    date: "2026-03-05",
    reading: 5,
  },
  {
    slug: "clocks",
    title: "Text clocks",
    desc: "Designing and manufacturing clocks that use natural-language to display time",
    tags: [Tag.project],
    date: "2026-03-22",
    reading: 7,
  },
  {
    slug: "online-clipboard",
    title: "Websocket clipboard",
    desc: "An online clipboard sharing application leveraging shared websocket sessions",
    tags: [Tag.web, Tag.project],
    date: "2026-04-10",
    reading: 5,
  },
  {
    slug: "pattern-matching-lsp",
    title: "Pattern-matching LSP",
    desc: "A language-agnostic LSP implementation based on regex pattern matching",
    tags: [Tag.tooling, Tag.project],
    date: "2026-04-28",
    reading: 8,
  },
  {
    slug: "my-terminal-addiction",
    title: "Terminal addiction",
    desc: "I tried fzf one time and now I can't stop myself",
    tags: [Tag.tooling, Tag.workflow],
    date: "2026-05-29",
    reading: 6,
    body: MyTerminalAddictionBody,
  },
  {
    slug: "vim-vs-emacs",
    title: "Vim or Emacs?",
    desc: "(or neither?)",
    tags: [Tag.tooling, Tag.workflow],
    date: "2026-05-30",
    reading: 6,
  },
  {
    slug: "travel-agent",
    title: "Travel agent",
    desc: "I'm never using google flight or skyscanner again",
    tags: [Tag.project, Tag.life],
    date: "2026-05-30",
    reading: 6,
  },
];

/** Posts sorted newest-first. */
export function postsByDate(): Post[] {
  return [...posts].sort((a, b) => b.date.localeCompare(a.date));
}

/** Slug of the most recent post — the default view on first load. */
export function mostRecentSlug(): string {
  return postsByDate()[0].slug;
}

export function getPost(slug: string): Post | undefined {
  return posts.find((p) => p.slug === slug);
}
