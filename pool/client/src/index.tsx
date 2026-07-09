import { render } from "solid-js/web";
import { Route, Router, useNavigate } from "@solidjs/router";
import { createSignal, onCleanup, onMount, For, type Component } from "solid-js";
import Game from "./Game";
import { fetchRooms, type RoomInfo } from "./net";
import { parseReplay, setPendingReplay } from "./replay";
import {
  COLOR_CHOICES,
  EMOJI_CHOICES,
  loadProfile,
  saveProfile,
  type PlayerProfile,
} from "./profile";
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

  // Player identity — chosen here, persisted, and read back in-game. Every edit
  // saves immediately so it's ready when a room is entered.
  const [profile, setProfile] = createSignal<PlayerProfile>(loadProfile());
  const update = (patch: Partial<PlayerProfile>) => {
    const next = { ...profile(), ...patch };
    setProfile(next);
    saveProfile(next);
  };

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
      {/* Player customization: name, cue colour, emoji. */}
      <div class="mm-profile">
        <div class="mmp-preview">
          <span class="mmp-emoji-lg">{profile().emoji}</span>
          <span class="mmp-name-lg" style={{ color: profile().color }}>
            {profile().name || "Player"}
          </span>
        </div>
        <input
          class="mmp-input"
          type="text"
          placeholder="your name"
          maxLength={16}
          value={profile().name}
          onInput={(e) => update({ name: e.currentTarget.value })}
        />
        <div class="mmp-label">cue colour</div>
        <div class="mmp-swatches">
          <For each={COLOR_CHOICES}>
            {(c) => (
              <button
                class="mmp-swatch"
                classList={{ sel: profile().color === c }}
                style={{ background: c }}
                title="cue colour"
                onClick={() => update({ color: c })}
              />
            )}
          </For>
        </div>
        <div class="mmp-label">emoji</div>
        <div class="mmp-emojis">
          <For each={EMOJI_CHOICES}>
            {(em) => (
              <button
                class="mmp-emoji"
                classList={{ sel: profile().emoji === em }}
                onClick={() => update({ emoji: em })}
              >
                {em}
              </button>
            )}
          </For>
        </div>
      </div>

      <div class="mm-actions">
        <button
          class="primary mm-start"
          onClick={() => navigate(`/${newCode()}`)}
        >
          New Game
        </button>
        {/* Load a saved replay: parse here, stash it, then enter a fresh room
            that consumes it on mount and plays the shots back. */}
        <label class="primary mm-start mm-load">
          Load Replay
          <input
            type="file"
            accept="application/json"
            style={{ display: "none" }}
            onChange={async (e) => {
              const f = e.currentTarget.files?.[0];
              e.currentTarget.value = "";
              if (!f) return;
              try {
                setPendingReplay(parseReplay(await f.text()));
                navigate(`/${newCode()}`);
              } catch {
                alert("Not a valid pool replay file.");
              }
            }}
          />
        </label>
      </div>
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
