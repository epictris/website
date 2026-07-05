import { render } from "solid-js/web";
import { Route, Router, useNavigate } from "@solidjs/router";
import { createSignal, onCleanup, onMount, For, type Component } from "solid-js";
import Game from "./Game";
import { fetchRooms, type RoomInfo } from "./net";
import "./styles.css";

// Generate a short random room code (URL-safe, no lookalike chars).
function newCode(): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(7));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

// Landing (main menu): "New Game" mints a room and enters it (you wait there as
// a solo table until someone joins), and below it a live lobby of every game
// with a single player waiting — each one joinable in a tap, no link needed.
const Landing: Component = () => {
  const navigate = useNavigate();
  const [rooms, setRooms] = createSignal<RoomInfo[]>([]);
  const [loaded, setLoaded] = createSignal(false);

  const refresh = async () => {
    setRooms(await fetchRooms());
    setLoaded(true);
  };

  onMount(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    onCleanup(() => clearInterval(t));
  });

  return (
    <div class="main-menu landing">
      <div class="menu-head">
        <span class="title">
          pool<span class="dim">.tris.sh</span>
        </span>
      </div>
      <button
        class="primary mm-start"
        onClick={() => navigate(`/${newCode()}`)}
      >
        New Game
      </button>
      <div class="lobby">
        <div class="lobby-head">Joinable games</div>
        <For
          each={rooms()}
          fallback={
            <div class="lobby-empty">
              {loaded() ? "No open games — start one!" : "Loading…"}
            </div>
          }
        >
          {(r) => (
            <div class="lobby-row">
              <span class="lobby-code">{r.code}</span>
              <button onClick={() => navigate(`/${r.code}`)}>Join</button>
            </div>
          )}
        </For>
      </div>
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
