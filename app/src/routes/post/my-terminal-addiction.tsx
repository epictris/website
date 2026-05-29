import { Title } from "@solidjs/meta";
import { A } from "@solidjs/router";
import { PostPreview, Tag } from "../../components/PostPreview";
import { CodeBlock } from "../../components/CodeBlock";
import "./post.css";

const post = {
  slug: "my-terminal-addiction",
  title: "My terminal addiction",
  desc: "I tried fzf one time and it took over my life",
  tags: [Tag.tooling, Tag.workflow],
  date: "2026-05-29",
  reading: 6,
};

export default function HelloWorld() {
  return (
    <main class="post-page">
      <Title>Learning to love the CLI — tris.sh</Title>

      <div class="h-sep" aria-hidden="true" />
      <A href="/" class="site-title-bar">tris.sh</A>
      <div class="h-sep" aria-hidden="true" />

      <div class="post-preview">
        <PostPreview post={post} />
      </div>

      <br/>
      <article class="post-body">
        <h2><span class="preview-title-hash">#</span> My terminal addiction</h2>
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
      </article>
    </main>
  );
}
