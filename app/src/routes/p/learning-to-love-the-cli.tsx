import { Title } from "@solidjs/meta";
import "./post.css";

export default function HelloWorld() {
  return (
    <main class="post-page">
      <Title>Learning to love the CLI — tris.sh</Title>

      <article box-="square" class="post-body">
        <h1># Learning to love the CLI</h1>
        <p>
          For most people, navigating a command line interface (CLI) is tantamount to black magic. Even among developers, CLIs are often seen as a necessary evil.
        </p>
        <br/>
        <h2>## What's the point?</h2>
        <p>
           I came across the phrase "terminal-based text editor" when I was in high school, at a time when my experience with command line interfaces essentially amounted to triggering the Sticky Keys root access exploit on Windows 7 machines, and trying (sometimes succeeding) to compile/run java code. I couldn't fathom why anyone would prefer to edit documents or search their file system with a tool as cumbersome and error-prone as a CLI. I already had VS Code for editing text, and File Explorer for navigating my file system - why would I need anything else?
        </p>
        <br/>
        <h2>## Forcing function</h2>
        <p>
          In 2023 I started my first full-time software engineering role. Engineers were expected to merge 15 PRs into production each week, and though I wasn't expected to hit those KPIs immediately, it was obvious that the coding workflow I'd grown comfortable with in the preceding years wasn't going to cut it. The codebase was several orders of magnitude larger than any in which I'd previously worked, and every new ticket found me in new unfamiliar terrain.
        </p>
        <br/>
        <h2>## The problem</h2>
        <p>
          When given a task, I was perfectly capable of finding the relevant code, figuring out what change needed to be made, then implementing the feature/fixing the bug. 
          <br/>
          <br/>
          But I wasn't fast.
          <br/>
          <br/>
          To create a file, I'd click through the file tree until I found the appropriate directory. To look for relevant code, I'd use VS Code's full text search and click through all the results until I found one that seemed relevant. To find a function or type definition, I'd use whatever language server extension I'd installed and hope that it would work when I needed it to. I'd open up so many tabs that I'd lose track of which were relevant to the current task and end up wasting time closing/reordering tabs and repeating searches I'd already made. I'd follow a code path that jumped around multiple files then struggle to find the file I was originally editing. I'd log in every morning and struggle to find what I'd been working on the previous evening. I'd waste time debugging my local dev environment after it had broken (or appeared to have broken) due to some simple misunderstanding.
          <br/>
          <br/>
          I felt like I was fighting against my own tools, but I also knew that the problems I was facing were solvable.
        </p>
      </article>
    </main>
  );
}
