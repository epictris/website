import { Title } from "@solidjs/meta";
import "./post.css";

export default function HelloWorld() {
  return (
    <main class="post-page">
      <Title>Learning to love the CLI — tris.sh</Title>

      <article box-="square" class="post-body">
        <h1># My terminal addiction</h1>
        <p>
          When I first heard about fzf, I didn't really understand why anyone would use it. I had a vague notion about what it did, but at the time I guess I just didn't really feel like I needed it. That all changed when I moved halfway across the world for a software engineering role in 2023. I was struggling to hit my performance targets and I started looking for a fix.
        </p>
        <br/>

        <h2>## What is fzf?</h2>
        <p>
          Fzf is a command-line fuzzy finder. It's a tool that lets you search through a list of items and select one of them. It's similar to how you might use the search bar in a web browser to find a specific website. Fzf is a powerful tool that can be used in many different ways, but for the purposes of this post I'll focus on its use as a fuzzy finder.
        </p>


        <br/>
        <h2>## Why would anyone use a CLI?</h2>
        <p>
           I was in high school when I first encountered the phrase "terminal-based text editor". At the time my experience with command line interfaces essentially amounted to triggering the Sticky Keys root access exploit on Windows 7 machines, and trying (sometimes succeeding) to compile/run java code. I couldn't fathom why anyone would prefer to edit documents or search their file system with a tool as cumbersome and esoteric as a CLI. I had VS Code for text editing and File Explorer for navigating my file system - why would I need anything else?
        </p>
        <br/>
        <h2>## Forcing function</h2>
        <p>
          In 2023 I started my first full-time software engineering role. Engineers were expected to merge 15 PRs into production each week, and though I wasn't expected to hit those KPIs immediately, it was obvious that the coding workflow I'd grown comfortable with in the preceding years wasn't going to cut it. The codebase was several orders of magnitude larger than any in which I'd previously worked, and every new ticket found me in unfamiliar terrain.
        </p>
        <br/>
        <h2>## The problem</h2>
        <p>
          When given a task, I was perfectly capable of finding the relevant code, figuring out what change needed to be made, then implementing the feature/fixing the bug. 
          <br/>
          <br/>
          But I was slow.
          <br/>
          <br/>
          Opening a file meant waiting 5-10 seconds for VS Code to boot and initialize. Creating a file meant clicking through a deeply nested file tree to find the target directory. Searching for relevant code meant running a full text search and clicking through all the results until I found one that seemed relevant. Finding a function or type definition meant using whatever language server extension I'd installed and hoping to get a result in a reasonable amount of time. I'd open up so many tabs that I'd lose track of the relevant files and end up wasting time closing/reordering tabs and repeating searches. I'd follow a code path that jumped across multiple files and lose track of which file I was editing. I'd log in every morning and struggle to locate everything I'd been working on the previous evening. I'd waste time debugging my local dev environment after it had broken (or appeared to have broken) due to a simple misunderstanding.
          <br/>
          <br/>
          I felt like I was fighting against my tools, but I also knew that the problems I was facing were solvable.
        </p>
        <br/>
        <h2>## The solution</h2>
        <p>
          I set some goals for my optimal workflow. I don't think I laid these out explicitly at the time, but in retrospect this is what I wanted:
        </p>
        <ul>
          <li>At any time, regardless of what I am currently doing on my computer, I should be able to open any file in any workspace in less than 5 seconds.</li>
          <li>Whenever I need to context switch, I should be able to instantly pick up wherever I left off once I'm able to refocus on the task.</li>
        </ul>
      </article>
    </main>
  );
}
