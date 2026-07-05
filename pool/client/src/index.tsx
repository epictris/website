import { render } from "solid-js/web";
import { Route, Router } from "@solidjs/router";
import { createSignal, type Component } from "solid-js";
import Game from "./Game";
import "./styles.css";

// Generate a short random room code (URL-safe, no lookalike chars).
function newCode(): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(7));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

// Landing (main menu). For now it's a single Multiplayer button: it mints a new
// session and copies the invite link to the clipboard — WITHOUT navigating. The
// player stays here; opening the link (yourself or a friend) enters the game.
const Landing: Component = () => {
  const [link, setLink] = createSignal("");
  const startMultiplayer = () => {
    const url = `${location.origin}/${newCode()}`;
    navigator.clipboard?.writeText(url).catch(() => {});
    setLink(url);
  };
  return (
    <div class="main-menu landing">
      <div class="menu-head">
        <span class="title">
          pool<span class="dim">.tris.sh</span>
        </span>
      </div>
      <button class="primary mm-start" onClick={startMultiplayer}>
        Multiplayer
      </button>
      <div class="link-row">
        {link()
          ? "Invite link copied to your clipboard — open it to start, and send it to a friend to play."
          : "Creates a new game and copies its invite link to your clipboard."}
      </div>
      {link() && (
        <div class="link-row">
          <a href={link()}>{link()}</a>
        </div>
      )}
    </div>
  );
};

render(
  () => (
    <Router>
      <Route path="/" component={Landing} />
      <Route path="/:room" component={Game} />
    </Router>
  ),
  document.getElementById("root")!,
);
