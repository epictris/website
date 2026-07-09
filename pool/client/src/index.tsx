import { render } from "solid-js/web";
import { Route, Router, useNavigate } from "@solidjs/router";
import { createSignal, onCleanup, onMount, For, Show, type Component } from "solid-js";
import Game from "./Game";
import { fetchRooms, type RoomInfo } from "./net";
import { parseReplay, setPendingReplay } from "./replay";
import {
  COLOR_CHOICES,
  loadProfile,
  saveProfile,
  type PlayerProfile,
} from "./profile";
import { EMOJI_DB } from "./emojis";
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

  // Emoji picker — the same searchable modal used in-game, over the full EMOJI_DB.
  const [showEmojiPicker, setShowEmojiPicker] = createSignal(false);
  const [emojiSearch, setEmojiSearch] = createSignal("");
  const filteredEmojis = () => {
    const q = emojiSearch().trim().toLowerCase();
    if (!q) return EMOJI_DB;
    return EMOJI_DB.filter((e) => e.name.includes(q) || e.ch === q);
  };
  const pickEmoji = (ch: string) => {
    update({ emoji: ch });
    setShowEmojiPicker(false);
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
      {/* Two columns: New Game / Load Replay / joinable games on the left, player
          customization on the right. */}
      <div class="mm-cols">
        <div class="mm-left">
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

        <div class="mm-right">
          {/* Player customization: name, cue colour, emoji. */}
          <div class="mm-profile">
            <div class="mmp-label">name &amp; emoji</div>
            <div class="mmp-row">
              <input
                class="mmp-input"
                type="text"
                placeholder="your name"
                maxLength={16}
                value={profile().name}
                onInput={(e) => update({ name: e.currentTarget.value })}
              />
              <button
                class="mmp-emoji-pick"
                onClick={() => {
                  setEmojiSearch("");
                  setShowEmojiPicker(true);
                }}
              >
                <span class="mmp-emoji-cur">{profile().emoji}</span>
                <span class="mmp-emoji-hint">change…</span>
              </button>
            </div>
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
          </div>
        </div>
      </div>

      {/* Searchable emoji picker (shared styles with the in-game modal). Tap an
          emoji to pick it as the profile avatar. */}
      <Show when={showEmojiPicker()}>
        <div class="menu-backdrop" onClick={() => setShowEmojiPicker(false)} />
        <div class="pick-modal emoji-modal">
          <div class="emoji-modal-head">
            <span class="pm-title">emojis</span>
            <button
              class="emoji-close"
              title="close"
              onClick={() => setShowEmojiPicker(false)}
            >
              ✕
            </button>
          </div>
          <input
            class="emoji-search"
            type="text"
            placeholder="search emojis…"
            value={emojiSearch()}
            onInput={(e) => setEmojiSearch(e.currentTarget.value)}
          />
          <div class="emoji-grid">
            <For each={filteredEmojis()}>
              {(em) => (
                <button
                  class="pick-emoji"
                  classList={{ sel: profile().emoji === em.ch }}
                  title={em.name}
                  onClick={() => pickEmoji(em.ch)}
                >
                  {em.ch}
                </button>
              )}
            </For>
          </div>
        </div>
      </Show>
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
