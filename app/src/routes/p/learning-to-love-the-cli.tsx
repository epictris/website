import { Title } from "@solidjs/meta";
import "./post.css";

export default function HelloWorld() {
  return (
    <main class="post-page">
      <Title>Hello, world — tris.sh</Title>

      <article box-="square" class="post-body">
        <h1># Working from the command line</h1>
        <p>
          For most people, navigating a command line interface (CLI) is tantamount to black magic. Even among developers, CLIs are often seen as a necessary evil.
        </p>
        <br/>
        <h2>## What's the point?</h2>
        <p>
           I came across the phrase "terminal-based text editor" when I was in high school, at a time when my experience with command line interfaces essentially amounted to triggering the Sticky Keys root access exploit on Windows 7 machines, and trying (sometimes succeeding) to compile/run java code. I couldn't fathom why anyone would prefer to edit documents/search their file system with a tool as cumbersome and error-prone as a CLI. I already had VS Code for editing text, and File Explorer for navigating my file system - why would I need anything else?
        </p>
        <br/>
        <h2>## Forcing function</h2>
        <p>
          In 2023 I started my first full-time software engineering role. Engineers were expected to merge 15 PRs into production each week (~3/day), and though I had a few weeks buffer before I was expected to hit those KPIs, it was immediately obvious that the coding workflow I'd grown comfortable with in the preceding years wasn't going to cut it. The codebase was several orders of magnitude larger than any in which I'd previously worked, and every new ticket had me working in new unfamiliar terrain.
        </p>
      </article>
    </main>
  );
}
