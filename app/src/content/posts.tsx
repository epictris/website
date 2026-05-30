import { CodeBlock } from "../components/CodeBlock";
import { Tag, type Post } from "../components/PostPreview";

// ── Post bodies ─────────────────────────────────────────────
// Each written post gets a body component here and is attached to its entry in
// `posts` below. Posts without a body fall back to the snapshot card.

function MyTerminalAddictionBody() {
  return (
    <>
      <p>
        I never really understood why anyone would prefer to use a command line interface (CLI) over a graphical user interface (GUI). How could typing out a command be more convenient than just clicking a button? Memorizing commands and debugging syntax errors felt like a chore, and even performing simple operations felt cumbersome and archaic. I always struggled to build a mental model of the file system I was working with, and I wondered if my aphantasia was to blame. Perhaps using a CLI required visualisation abilities I simply did not possess.


        <br/>
        <br/>
        </p>
      <h2><span class="preview-title-hash">##</span> A catalyst for change</h2>
      <p>

        In my first software engineering job I was working across multiple repos and I'd often find myself needing to context switch to quickly debug/test/check something in a different repo. Every time, this meant closing VS Code, opening a file browser, clicking through to the target directory, waiting for VS Code to boot/initialize in that new directory, then searching for the files I needed. Once I'd finished, I'd repeat the whole process and hope I still remembered what I'd been working on originally. 15-20 seconds of downtime doesn't sound like a lot, but if I just need to check some value or jot down a quick note, 15-20 seconds feels like an eternity - and for a guy like me it's plenty of time to forget the reason I was context switching in the first place.

        <br/>
        <br/>

        The frustrating part was that I knew it didn't have to be this slow. I'd seen some crazy workflows online where people were flying around their terminal environment - using vim to search files and edit text, and running commands so quickly I could barely keep track of what was happening. But whenever I tried to use vim for some quick text editing, I'd end up fighting against the CLI and waste more time than if I'd just done things the normal way.
      </p>
      <br/>
      <h2><span class="preview-title-hash">##</span> A breakthrough</h2>
      <p>
        While searching for solutions, I came across fzf - a command-line fuzzy finder. It basically lets you run a fuzzy search over any input data, then prints the selected result to the command line. Not very useful on its own, but I realised that I could combine it with other commands to solve my two biggest pain points:
      </p>
      <br/>
      <ol>
        <li>Navigating to a specific directory (quickly)</li>
        <li>Opening a specific file somewhere in that directory (quickly)</li>
      </ol>
      <br/>
      <h2><span class="preview-title-hash">###</span> Rapid directory navigation</h2>
      <p>
        I realised that I could define a list of all the directories I frequently accessed, use fzf to search through them, then <code>cd</code> to the selected directory. If I wrap this logic into a terminal alias, <i>I can navigate to any of these directories in less than a second with just a few keystrokes</i>.
      <CodeBlock code={`DIRS=$(cat << ---
~/.config/nvim
~/.config/tmux
~/.dotfiles
~/Downloads
~/projects/command-reference
~/projects/website
~/repos/example
---
)
alias d='dir=$(echo $DIRS | fzf) && eval cd $dir'`} />
      </p>
      <p>
        If you're not sure what I mean, try this out for yourself (assuming you're on a Unix-like system)
      </p>
      <br/>
      <h2><span class="preview-title-hash">###</span> Rapid file search</h2>
      <p>
        I also realised that I could use a similar approach to pipe a list of all the files in the current directory to <code>fzf</code>, then open the selected file in <code>nvim</code>. When combined with the directory navigation alias, <i>this allows me to open any file in any target directory in less than 3 seconds with only 5-10 keystrokes</i> (assuming I know roughly where the file is located)
      </p>
      <CodeBlock code={`alias s='file=$(find . -type f | colrm 1 2 | fzf) && nvim $file'`} />
      <br/>

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
  { slug: "my-terminal-addiction",      title: "Terminal addiction",           desc: "I tried fzf one time and now I can't stop myself",        tags: [Tag.tooling, Tag.workflow], date: "2026-05-29", reading: 6, body: MyTerminalAddictionBody },
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
