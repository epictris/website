import { CodeBlock } from "../components/CodeBlock";
import { type Post, Tag } from "../components/PostPreview";

// ── Post bodies ─────────────────────────────────────────────
// Each written post gets a body component here and is attached to its entry in
// `posts` below. Posts without a body fall back to the snapshot card.

function MyTerminalAddictionBody() {
  return (
    <>
      <p>
        Before I started working as a software engineer, I would only ever use a
        command line interface (CLI) if there was no graphical alternative. Each
        instance felt like a battle against the archaic syntax of a legacy
        technology, and I would struggle to build a mental model of the file
        system I was working in. Today, the CLI is at the core of my development
        workflow, and I'm constantly looking for ways to replace GUI tools with
        CLI alternatives.
        <br />
        <br />
      </p>
      <h2>
        <span class="preview-title-hash">##</span> The catalyst
      </h2>
      <p>
        My comfortable coding workflow went out the window when I started my
        first software engineering role. I'd never been in an environment with
        such a high bar for performance - but more significantly, I'd never been
        surrounded by so many people capable of meeting and exceeding that bar.
      </p>
      <br />
      <p>
        Trying (and failing) to merge 15 PRs into production per week across
        millions of lines of code made me realise that something fundamental
        needed to change about my workflow.
        <br />
        <br />
      </p>
      <h2>
        <span class="preview-title-hash">##</span> The goal
      </h2>
      <p>
        I'd seen some crazy videos online with people flying around their
        terminal environment, searching/editing files and running commands so
        quickly I'd lose track of what was happening. I wanted that speed and
        precision, but every time I dabbled with <code>vim</code> for some quick
        text editing, I'd end up fighting against the CLI and waste more time
        than if I'd just done things the normal way.
      </p>
      <br />
      <h2>
        <span class="preview-title-hash">##</span> The breakthrough
      </h2>
      <p>
        I came across <code>fzf</code> - a command-line fuzzy finder. Invoking{" "}
        <code>fzf</code> runs a fuzzy search over the files in the current
        directory and prints the name of the selected file. A year prior I would
        have dismissed this as a triviality, but my recent exploration had
        fundamentally shifted my perspective.
        <br />
        <br />
        The CLI is not a set of disparate commands to memorize. It's a system
        for composing data transformation pipelines with tools that use text as
        a universal interface. This reflects the Unix philosophy:
        <br />
        <br />
      </p>
      <ul>
        <li>Write programs that do one thing and do it well.</li>
        <li>Write programs to work together</li>
        <li>
          Write programs to handle text streams, because that is a universal
          interface
        </li>
      </ul>
      <p>
        <br />
        CLI tools are designed to be used as composable parts of a pipeline -
        not in isolation.
        <br />
        <br />
        This design philosophy allows a tool like <code>fzf</code> to provide
        enormous value. It isn't limited to fuzzy searching files - it can
        search any given text input. Printing the selection is useless in
        isolation, but incredibly useful when that selection is used as the
        input to another CLI tool.
        <br />
        <br />
        When I learned about <code>fzf</code>, I realised that it could solve my
        two biggest pain points:
      </p>
      <br />
      <ol>
        <li>Navigating to a specific directory (quickly)</li>
        <li>Opening a specific file somewhere in that directory (quickly)</li>
      </ol>
      <br />
      <h2>
        <span class="preview-title-hash">###</span> Directory navigation
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
        <span class="preview-title-hash">###</span> File search
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
      <CodeBlock code={`alias s='file=$(rg --files | fzf) && nvim $file'`} />
      <br />
    </>
  );
}

// ── Registry ────────────────────────────────────────────────

export const posts: Post[] = [
  {
    slug: "my-terminal-addiction",
    title: "Terminal addiction",
    desc: "I tried fzf one time and now I can't stop myself",
    tags: [Tag.tooling, Tag.workflow],
    date: "2026-05-29",
    reading: 6,
    body: MyTerminalAddictionBody,
  },
  // {
  //   slug: "nvim-config",
  //   title: "My neovim config",
  //   desc: "Thoughts on the design and implementation of my neovim config",
  //   tags: [Tag.tooling],
  //   date: "2025-11-18",
  //   reading: 10,
  // },
  // {
  //   slug: "keyboard-layout",
  //   title: "Custom keyboard layout",
  //   desc: "How I designed my own keyboard layout",
  //   tags: [Tag.tooling],
  //   date: "2025-12-02",
  //   reading: 8,
  // },
  // {
  //   slug: "8ball-pool",
  //   title: "8-ball pool",
  //   desc: "A realtime 8-ball pool game I made",
  //   tags: [Tag.web, Tag.game],
  //   date: "2025-12-20",
  //   reading: 6,
  // },
  // {
  //   slug: "garmin-watch-face",
  //   title: "Garmin watch face",
  //   desc: "A custom watch face I developed for my Garmin watch",
  //   tags: [Tag.project],
  //   date: "2026-01-15",
  //   reading: 5,
  // },
  // {
  //   slug: "dnd-character-sheet",
  //   title: "DnD character sheet",
  //   desc: "A character sheet I made using Obsidian's Canvas feature",
  //   tags: [Tag.project],
  //   date: "2026-02-01",
  //   reading: 4,
  // },
  // {
  //   slug: "python-orm",
  //   title: "Python query builder",
  //   desc: "A type-safe interface for building & validating complex query payloads",
  //   tags: [Tag.tooling, Tag.project],
  //   date: "2026-02-18",
  //   reading: 6,
  // },
  // {
  //   slug: "grappling-hook-game",
  //   title: "2D grappling hook game",
  //   desc: "My custom implementation of 2D grappling hook physics",
  //   tags: [Tag.game, Tag.project],
  //   date: "2026-03-05",
  //   reading: 5,
  // },
  // {
  //   slug: "clocks",
  //   title: "Text clocks",
  //   desc: "Designing and manufacturing clocks that use natural-language to display time",
  //   tags: [Tag.project],
  //   date: "2026-03-22",
  //   reading: 7,
  // },
  // {
  //   slug: "online-clipboard",
  //   title: "Websocket clipboard",
  //   desc: "An online clipboard sharing application leveraging shared websocket sessions",
  //   tags: [Tag.web, Tag.project],
  //   date: "2026-04-10",
  //   reading: 5,
  // },
  // {
  //   slug: "pattern-matching-lsp",
  //   title: "Pattern-matching LSP",
  //   desc: "A language-agnostic LSP implementation based on regex pattern matching",
  //   tags: [Tag.tooling, Tag.project],
  //   date: "2026-04-28",
  //   reading: 8,
  // },
  // {
  //   slug: "vim-vs-emacs",
  //   title: "Vim or Emacs?",
  //   desc: "(or neither?)",
  //   tags: [Tag.tooling, Tag.workflow],
  //   date: "2026-05-30",
  //   reading: 6,
  // },
  // {
  //   slug: "travel-agent",
  //   title: "Travel agent",
  //   desc: "I'm never using google flight or skyscanner again",
  //   tags: [Tag.project, Tag.life],
  //   date: "2026-05-30",
  //   reading: 6,
  // },
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
