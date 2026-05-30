import { CodeBlock } from "../components/CodeBlock";
import { Tag, type Post } from "../components/PostPreview";

// ── Post bodies ─────────────────────────────────────────────
// Each written post gets a body component here and is attached to its entry in
// `posts` below. Posts without a body fall back to the snapshot card.

function MyTerminalAddictionBody() {
  return (
    <>
      <p>
        When I first heard about fzf, I didn't understand why anyone would use it. I had a vague idea of what it did, but I didn't feel like I needed it at the time. That all changed when I moved halfway across the world for a software engineering role in 2023. I was struggling at my new job and started looking for a fix.
      </p>
      <br/>

      <h2><span class="preview-title-hash">##</span> What is fzf?</h2>
      <p>
        fzf is a command-line fuzzy finder. Opening a terminal and typing <code>fzf</code> will launch a fuzzy search over the names of all files in the current directory. As you type, the results will be filtered, and pressing Enter will print the name of the selected file.
      </p>
      <CodeBlock code="$ fzf" />
      <CodeBlock code={`▌ hello_world.txt
▌ hello.txt
> hlo
`} lang="text" />
      <CodeBlock code="hello.txt" lang="text" />
      <p>
        If you aren't familiar with the CLI, there's a good chance you're struggling to imagine a practical application for this. On its own, fzf is mostly useless - the magic happens when you leverage its fuzzy searching to supercharge other CLI tools.
      </p>

      <br/>
      <h2><span class="preview-title-hash">##</span> fzf + nvim</h2>
      <p>
        To open a file in nvim (neovim), you need to pass the relative path to the file as the first argument.
      </p>
      <CodeBlock code="$ nvim filename.txt" />
      <p>
        This quickly starts to feel cumbersome when you can't remember the exact name of the file, or it's buried in a deeply nested directory - if only there was a way to quickly search through all the files in the current directory...
      </p>
      <CodeBlock code="$ nvim $(fzf)" />
      <p>
        This is called a "command substitution". It allows the <code>nvim</code> command to receive the output of the <code>fzf</code> command as its first argument. When you run this command, you'll launch a fuzzy search over all the files in the current directory, but when you press Enter, the selected file will immediately be opened in <code>nvim</code>. I use the following terminal alias daily - it's just a more robust version of the previous command.
      </p>
      <CodeBlock code={`alias s='file=$(find . -type f | colrm 1 2 | fzf) && nvim $file'`} />

      <br/>
      <h2><span class="preview-title-hash">##</span> fzf + cd</h2>
      <p>
        <code>cd</code> has the same constraint as <code>nvim</code> - it requires a relative path as its first argument. The main difference is that when I run <code>cd</code>, I'm usually moving to a completely different directory - not going more deeply into the current directory - so how does fzf help out here if it only fuzzy finds over files in the current directory? Simple - if you pass data to fzf over STDIN, it will fuzzy-find over your input text instead. I have the following alias to quickly switch between my projects or other commonly-accessed directories:
      </p>
      <CodeBlock code={`DIRS=$(cat << ---
~/.config/nvim
~/.config/tmux
~/projects/website
~/projects/command-reference
~/projects/sddm-theme
~/.dotfiles
---
)
alias d='dir=$(echo $DIRS | fzf) && eval cd $dir'`} />
      <p>
        This allows me to run the command <code>d</code>, type a couple of characters to narrow down to a single directory, and press Enter to immediately switch to that directory. I use this multiple times per day.
      </p>
    </>
  );
}

// ── Registry ────────────────────────────────────────────────

export const posts: Post[] = [
  { slug: "nvim-config",                   title: "My neovim config",                   desc: "Thoughts on the design and implementation of my neovim config",                   tags: [Tag.tooling],               date: "2025-11-18", reading: 10 },
  { slug: "keyboard-layout",              title: "Custom keyboard layout",              desc: "How I designed my own keyboard layout",                                           tags: [Tag.tooling],               date: "2025-12-02", reading: 8  },
  { slug: "8ball-pool",                    title: "8-ball pool",                        desc: "A realtime 8-ball pool game I made",                                              tags: [Tag.web, Tag.game],         date: "2025-12-20", reading: 6  },
  { slug: "garmin-watch-face",             title: "Garmin watch face",                  desc: "A custom watch face I developed for my Garmin watch",                             tags: [Tag.project],               date: "2026-01-15", reading: 5  },
  { slug: "dnd-character-sheet",           title: "DnD character sheet",    desc: "A character sheet I made using Obsidian's Canvas feature",                        tags: [Tag.project],               date: "2026-02-01", reading: 4  },
  { slug: "python-orm",                    title: "Python query builder",               desc: "A type-safe interface for building & validating complex query payloads",           tags: [Tag.tooling, Tag.project],  date: "2026-02-18", reading: 6  },
  { slug: "grappling-hook-game",           title: "2D grappling hook game",             desc: "My custom implementation of 2D grappling hook physics",                           tags: [Tag.game, Tag.project],     date: "2026-03-05", reading: 5  },
  { slug: "clocks",                        title: "Text clocks",                         desc: "Designing and manufacturing clocks that use natural-language to display time",     tags: [Tag.project],               date: "2026-03-22", reading: 7  },
  { slug: "online-clipboard",              title: "Websocket clipboard",                 desc: "An online clipboard sharing application leveraging shared websocket sessions",     tags: [Tag.web, Tag.project],      date: "2026-04-10", reading: 5  },
  { slug: "pattern-matching-lsp",          title: "Pattern-matching LSP",               desc: "A language-agnostic LSP implementation based on regex pattern matching",           tags: [Tag.tooling, Tag.project],  date: "2026-04-28", reading: 8  },
  { slug: "my-terminal-addiction",      title: "My terminal addiction",           desc: "I tried fzf one time and I've been chasing that high ever since",        tags: [Tag.tooling, Tag.workflow], date: "2026-05-29", reading: 6, body: MyTerminalAddictionBody },
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
  return posts.find(p => p.slug === slug);
}
