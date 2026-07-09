import { createSignal, For, onCleanup, onMount, Show, type Component } from "solid-js";
import { Portal } from "solid-js/web";
import { useNavigate, useParams } from "@solidjs/router";
import {
  applyShot,
  atRest,
  cloneWorld,
  DEFAULT_CONFIG,
  freeze,
  FIXED_DT,
  IDENT3,
  integrateSpin,
  MAX_ELEVATION,
  POCKET_LIST,
  predictPaths,
  R,
  RAIL_INSET,
  rackWorld,
  rackSeed,
  stepFixed,
  TABLE,
  type Ball,
  type Mat3,
  type PhysicsConfig,
  type Prediction,
  type ShotEvent,
  type Shot,
  type Vec,
  type World,
} from "./physics";
import { cueSpriteDataURL, drawScene, layoutFor, type Aim, type CueDraw, type Layout } from "./render";
import { evaluateShot, groupOf, initRules, type RulesState } from "./rules";
import { wsUrl, type Msg } from "./net";
import {
  cueBand,
  loadProfile,
  loadQuickEmojis,
  saveQuickEmojis,
  type PlayerProfile,
} from "./profile";
import { EMOJI_DB } from "./emojis";
import {
  buildReplay,
  downloadReplay,
  snapshotInitial,
  takePendingReplay,
  worldFromInitial,
  type Replay,
  type ReplayShot,
} from "./replay";

const Game: Component = () => {
  const room = useParams().room ?? "lobby";
  const seed = rackSeed(room); // shared room id -> both clients rack identically
  const navigate = useNavigate();
  let canvas!: HTMLCanvasElement; // full-screen table canvas (felt, balls, cue, lines)
  let hitEl!: HTMLDivElement; // pointer target over the table + cue overhang
  let tableWrap!: HTMLDivElement; // spacer reserving the felt's slot in the flex row
  let ctx!: CanvasRenderingContext2D;
  let layout: Layout; // full-screen draw layout (origin recentred each frame)
  let layoutBase: Layout; // felt-box layout from layoutFor (before centring offset)

  // --- High-frequency mutable state (not Solid-reactive) ------------------
  let world: World = rackWorld(seed);
  let initialWorld: World = cloneWorld(world);
  let history: ReplayShot[] = [];
  // Count of fully *resolved* shots (incremented in resolveShot, monotonic across
  // re-racks). This is the sync-staleness comparator: it advances only once a shot
  // reaches rest, so a peer that applied a shot but hasn't resolved it yet reads as
  // behind — exactly when it needs the opponent's sync to learn the turn flipped.
  let shotCount = 0;
  // Monotonic shot count for the whole game (never reset by a mid-game re-rack),
  // so it matches the server's log length; used to decide when a shot-log rebuild
  // is needed. `rebuilding` suppresses turn-recap popups during that replay.
  let totalShots = 0;
  let rebuilding = false;
  // True once a shared game exists. Gates the host's join-time re-rack so it fires
  // only for the genuine first opponent — a later reconnect (drop → rejoin) must
  // resync the game in progress, not wipe it.
  let gameStarted = false;
  let events: ShotEvent[] = [];
  let acc = 0; // physics time accumulator
  let last = 0;
  let pendingPlace: Vec | undefined;
  // Pointer routing on the table. A gesture is a *tap* (release under TAP_PX of
  // travel → snap aim / open a modal) or a *drag* (over it → fine aim / place).
  const TAP_PX = 7;
  const AIM_GAIN = 0.32; // felt-drag rotates the aim this fraction of the finger
  const LONGPRESS_MS = 300; // hold on the cue ball (no swipe) to grab it in-hand
  const SPIN_REACH_PX = 90; // finger travel (canvas px) that maps to full deflection
  // Spin-face labels: eight positions (unit dir on screen, up = follow/High).
  const SPIN_DIRS: [number, number, string][] = [
    [1, 0, "R"],
    [Math.SQRT1_2, -Math.SQRT1_2, "HR"],
    [0, -1, "High"],
    [-Math.SQRT1_2, -Math.SQRT1_2, "HL"],
    [-1, 0, "L"],
    [-Math.SQRT1_2, Math.SQRT1_2, "LL"],
    [0, 1, "Low"],
    [Math.SQRT1_2, Math.SQRT1_2, "LR"],
  ];
  // Cue-stick hit band: behind the ball, along the aim axis, within this half-width.
  const STICK_NEAR = R * 1.2; // starts just off the ball surface
  const STICK_FAR = R * 34; // ...out to the drawn cue length (image is ~32·R long)
  const STICK_PERP = R * 2.7; // perpendicular reach either side of the stick line
  // Gesture the current canvas drag is performing. "spin"/"elev" are new direct
  // manipulations; "place" is the ball-in-hand reposition (now long-press-gated).
  let mode: "aim" | "place" | "spin" | "elev" | null = null;
  let downClient = { x: 0, y: 0 }; // pointer-down screen px (tap/drag test)
  let downWorld: Vec = { x: 0, y: 0 }; // pointer-down world point (aim snap)
  let downFinger = 0; // angle cue→finger at press (fine-aim reference)
  let lastFinger = 0; // finger angle at the previous move (delta integration)
  let aimAccum = 0; // accumulated finger swing this drag (avoids ±2π wrap snaps)
  let aimStart = 0; // aimAngle at press (fine-aim / elev axis reference)
  let movedFar = false; // travelled past TAP_PX this gesture
  let spinDownLocal = { x: 0, y: 0 }; // spin-drag origin in canvas-local px
  let elevStart = 0; // elevation at press (elev-drag reference)
  let projStart = 0; // finger's along-axis distance at press (elev-drag reference)
  let lpTimer: ReturnType<typeof setTimeout> | undefined; // in-hand long-press
  let placeMode = false; // cue ball grabbed for repositioning (grows it in draw)
  let aimAngle = 0;
  let prediction: Prediction | undefined;
  let breaker: 0 | 1 = 0;
  let lastPresence = 0;
  let worldBefore: World = cloneWorld(world);
  let ws: WebSocket | null = null;
  let leaving = false; // set on unmount so a deliberate close doesn't reconnect
  let replayQueue: ReplayShot[] = [];
  let shotConfig: PhysicsConfig = DEFAULT_CONFIG; // config a shot animates under
  let opp: { cursor?: Vec; aim?: Aim } = {};
  // Live table annotation (pointing finger + dotted paths). Both players can draw
  // at once, so every stream is keyed by its author's slot: `cur[slot]` is that
  // author's in-progress stroke and `pointers[slot]` their live finger. Each
  // stroke carries the author's profile colour. Interleaving two authors into one
  // bucket (the old design) made a single line jump between both fingers and
  // orphaned strokes at Infinity expiry — hence the per-slot split.
  type Stroke = { pts: Vec[]; expireAt: number; color: string };
  type LivePointer = { pos: Vec; color: string };
  let annot: {
    pointers: Record<number, LivePointer>;
    strokes: Stroke[];
    cur: Record<number, Stroke | undefined>;
  } = { pointers: {}, strokes: [], cur: {} };
  const DRAW_HOLD_MS = 5000;
  // After the hold, the stroke "undoes" itself: it erases progressively from its
  // start point to where the drawer released, over this long.
  const DRAW_ERASE_MS = 700;
  let drawing = false; // a local annotation drag is in progress
  let lastDraw = 0; // network-send throttle for annotation moves
  // Emoji stamps dragged onto the table from the comm tray. Each pops in (scale
  // 0 → 1 with an overshoot), holds, then snaps away. `start` is the local clock.
  let stamps: { ch: string; pos: Vec; start: number }[] = [];
  const STAMP_POP_MS = 280; // grow-in with overshoot (20% faster than before)
  const STAMP_HOLD_MS = 2000; // full size this long
  const STAMP_GONE_MS = 160; // then rapidly shrink away
  const STAMP_LIFE = STAMP_POP_MS + STAMP_HOLD_MS + STAMP_GONE_MS;
  // easeOutBack — overshoots past 1 near the end, then settles back to it.
  const easeOutBack = (x: number) => {
    const c1 = 3.40316; // ~2× the standard 1.70158, so double the overshoot
    const c3 = c1 + 1;
    return 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2;
  };
  const stampScale = (age: number) => {
    if (age < STAMP_POP_MS) return Math.max(0, easeOutBack(age / STAMP_POP_MS));
    if (age < STAMP_POP_MS + STAMP_HOLD_MS) return 1;
    return Math.max(0, 1 - (age - STAMP_POP_MS - STAMP_HOLD_MS) / STAMP_GONE_MS);
  };
  // Ball-sinking animations (visual only).
  let sinks: { id: number; from: Vec; pocket: Vec; v: Vec; start: number; o0: Mat3 }[] = [];
  const pottedSeen = new Set<number>();
  let debugCursor: Vec | undefined; // world coords under the cursor (debug readout)
  let debugCopiedAt = -1e9; // nowMs of the last debug click-to-copy (for the flash)
  let nowMs = 0;
  const SINK_MS = 1000; // sink-anim lifetime (roll-in can be slow before the drop)
  // Speed (world m/s) a potted ball travels under the table from its pocket to
  // the return-track entrypoint at the bottom-left corner.
  const UNDER_MPS = 1.1;
  // Gutter entrypoint (world m): the bottom-left corner, where the return track
  // begins. The under-table delay scales with a pocket's distance from here.
  const GUTTER_ENTRY: Vec = { x: 0, y: TABLE.h };
  // The bottom-rail ball-return track: every ball potted this game, in the order
  // it dropped. Each rolls into the track once its pocket-drop (SINK_MS) finishes.
  let rackBalls: { id: number; rollStart: number }[] = [];
  const resetSinks = () => {
    sinks = [];
    pottedSeen.clear();
    rackBalls = [];
  };
  // Rebuild the rack from the current world with no roll animation — used when a
  // late joiner adopts a synced snapshot (which carries no pot-order history, so
  // fall back to id order and show the balls already settled).
  const seedRack = () => {
    rackBalls = world.balls
      .filter((b) => b.potted && b.id !== 0)
      .sort((a, b) => a.id - b.id)
      .map((b) => ({ id: b.id, rollStart: -1e9 }));
  };
  // Nearest pocket hole centre — where a potted ball visually drops to.
  const nearestHole = (p: Vec): Vec =>
    POCKET_LIST.reduce((a, b) =>
      Math.hypot(b.center.x - p.x, b.center.y - p.y) <
      Math.hypot(a.center.x - p.x, a.center.y - p.y)
        ? b
        : a,
    ).center;
  const addSink = (b: Ball, start: number) => {
    const v = b.dropV ?? { x: 0, y: 0 }; // momentum it carried into the pocket
    // Snapshot the ball's field orientation so the sink's roll continues from it
    // instead of snapping to identity.
    sinks.push({ id: b.id, from: { ...b.p }, pocket: nearestHole(b.p), v, start, o0: b.o ?? IDENT3 });
  };

  // --- UI-facing signals --------------------------------------------------
  const [rules, setRules] = createSignal<RulesState>(initRules(0));
  const [mySlot, setMySlot] = createSignal(-1);
  const [peerCount, setPeerCount] = createSignal(1);
  // My chosen identity (loaded once from localStorage), plus every connected
  // player's profile keyed by slot — populated from `profile` messages and my own
  // slot on `hello`. Drives the banner above the table and each cue's colour.
  const myProfile = loadProfile();
  const [profiles, setProfiles] = createSignal<Record<number, PlayerProfile>>({});
  const [power, setPower] = createSignal(0); // starts at zero; kept between shots
  const [follow, setFollow] = createSignal(0);
  const [side, setSide] = createSignal(0);
  const [elevation, setElevation] = createSignal(0); // radians
  const [config, setConfig] = createSignal<PhysicsConfig>(DEFAULT_CONFIG);
  const [bannerTop, setBannerTop] = createSignal(24); // banner y (centre of the top gap)
  const [animating, setAnimating] = createSignal(false);
  const [replaying, setReplaying] = createSignal(false);
  const [showMenu, setShowMenu] = createSignal(false); // hamburger menu modal
  const [showSpinHud, setShowSpinHud] = createSignal(false); // floating spin window
  const [spinHudPos, setSpinHudPos] = createSignal({ x: 0, y: 0 }); // canvas-local px
  const [spinAim, setSpinAim] = createSignal(0); // aim the spin pad is oriented to
  const [canvasH, setCanvasH] = createSignal(360); // sizes the cue column
  const [tableW, setTableW] = createSignal(360); // felt-box spacer size (flex slot)
  const [tableH, setTableH] = createSignal(360);
  const [debug, setDebug] = createSignal(false); // collision-geometry overlay
  const [fullscreen, setFullscreen] = createSignal(false);
  // Communication mode: a tap on the comm button enables freehand annotation AND
  // opens the emoji tray; tapping again closes both.
  const [comm, setComm] = createSignal(false);
  // Quick-select tray emojis (persisted). Swappable via the "more" picker.
  const [quickEmojis, setQuickEmojis] = createSignal<string[]>(loadQuickEmojis());
  const [showEmojiPicker, setShowEmojiPicker] = createSignal(false);
  const [pickerDragging, setPickerDragging] = createSignal(false); // hide picker mid-drag
  const [emojiSearch, setEmojiSearch] = createSignal("");
  let dragEl!: HTMLDivElement; // floating emoji preview that follows a tray drag
  let trayEl: HTMLDivElement | undefined; // quick tray, for drop-to-swap hit-testing
  let dragCh = ""; // emoji currently being dragged out of the tray/picker
  // Emoji entries filtered by the picker search box.
  const filteredEmojis = () => {
    const q = emojiSearch().trim().toLowerCase();
    if (!q) return EMOJI_DB;
    return EMOJI_DB.filter((e) => e.name.includes(q) || e.ch === q);
  };
  // Replace quick-tray slot `i` with `ch` and persist.
  const swapQuick = (i: number, ch: string) => {
    setQuickEmojis((prev) => {
      const next = [...prev];
      if (i >= 0 && i < next.length) next[i] = ch;
      saveQuickEmojis(next);
      return next;
    });
  };
  // Which quick-tray slot (if any) sits under a screen point — geometry-based so
  // it works under the rot90 transform and regardless of modal stacking.
  const traySlotAt = (x: number, y: number): number => {
    const nodes = trayEl?.querySelectorAll(".tray-emoji");
    if (!nodes) return -1;
    for (let i = 0; i < nodes.length; i++) {
      const r = (nodes[i] as HTMLElement).getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return i;
    }
    return -1;
  };
  // Transient turn-recap popup: what the last shot did + whose turn it is now.
  const [announce, setAnnounce] = createSignal<string | null>(null);
  let announceTimer: ReturnType<typeof setTimeout> | undefined;
  const showAnnounce = (text: string) => {
    setAnnounce(text);
    if (announceTimer) clearTimeout(announceTimer);
    announceTimer = setTimeout(() => setAnnounce(null), 4500);
  };
  onCleanup(() => announceTimer && clearTimeout(announceTimer));
  onCleanup(() => clearTimeout(lpTimer));
  // Portrait-locked phone held sideways: the whole game root is CSS-rotated 90°
  // (see .game-root.rot90) while the table itself stays laid out landscape.
  const [rot90, setRot90] = createSignal(false);
  // Fullscreen API is absent on iPhone Safari (iPad/Android/desktop are fine).
  const canFullscreen =
    typeof document !== "undefined" &&
    !!document.documentElement.requestFullscreen;
  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  };
  // Fullscreen play is delivered by installing to the home screen (the web
  // manifest's `display: fullscreen` + `orientation: landscape`), so there's no
  // in-app nudge — the desktop menu still exposes a manual fullscreen toggle.
  const [track, bump] = createSignal(0, { equals: false }); // force UI recompute

  const myPlayer = () => (mySlot() < 0 ? 0 : Math.min(mySlot(), 1));
  const solo = () => peerCount() <= 1;
  const isSpectator = () => mySlot() > 1;
  const myTurn = () =>
    rules().winner === null &&
    !isSpectator() &&
    (solo() || rules().turn === myPlayer());
  const canAct = () => !animating() && !replaying() && myTurn();
  // Freehand annotation is active whenever comm mode is on (and the player is a
  // live, non-spectator participant). Toggled by the comm button, independent of
  // whose turn it is — so it takes over the canvas from aiming while enabled.
  const canPoint = () =>
    comm() && !isSpectator() && rules().winner === null;

  // The connected participants (slots 0/1 with a known profile), for the banner
  // above the table. One player → shown centred; two → separated by "vs".
  const roster = () =>
    ([0, 1] as const).flatMap((slot) => {
      const p = profiles()[slot];
      return p
        ? [{ emoji: p.emoji, name: p.name || `Player ${slot + 1}`, color: p.color, slot }]
        : [];
    });

  // --- Networking ---------------------------------------------------------
  const send = (m: Partial<Msg>) => ws?.readyState === 1 && ws.send(JSON.stringify(m));

  // Announce my identity to the room (on join, and re-sent when a peer arrives so
  // late joiners learn it). The server tags it with my slot on relay.
  const sendProfile = () => send({ t: "profile", profile: myProfile } as Msg);

  const applySnapshotToPeer = (to: number) => {
    send({
      t: "sync",
      to,
      snap: {
        balls: world.balls.map((b) => ({
          id: b.id,
          x: b.p.x,
          y: b.p.y,
          potted: b.potted,
        })),
        rules: rules(),
        breaker,
        shotCount,
        config: config(),
      },
    } as Msg);
  };

  // Tell the server a fresh game started, so it resets its retained log to this
  // rack. Subsequent shots append to it and are re-sent to any (re)joining peer.
  const announceGameInit = () =>
    send({
      t: "game-init",
      initial: snapshotInitial(initialWorld),
      breaker,
      config: config(),
    } as Msg);

  // Losslessly rebuild the whole game from the server's retained log. Runs on a
  // (re)join: a client whose socket was suspended may have missed any number of
  // shots, and the server keeps no history beyond this log. The engine is
  // deterministic, so re-applying every shot from the initial rack reproduces the
  // exact live board, rules, turn, and (via runShot/resolveShot) the replay
  // history too — which is what keeps saved replays complete across disconnects.
  const rebuildFromLog = (log: {
    initial: { id: number; x: number; y: number }[];
    breaker: 0 | 1;
    config: PhysicsConfig;
    shots: ReplayShot[];
  }) => {
    // Already at this exact point in the game — nothing to replay.
    if (log.shots.length === totalShots) return;
    rebuilding = true;
    setReplaying(false);
    replayQueue = [];
    setAnimating(false);
    striking = false;
    lingering = false;
    strikeShot = undefined;
    acc = 0;
    world = worldFromInitial(log.initial);
    initialWorld = cloneWorld(world);
    history = [];
    shotCount = 0;
    totalShots = 0;
    breaker = log.breaker;
    gameStarted = true;
    pendingPlace = undefined;
    setConfig(log.config);
    setRules(initRules(log.breaker));
    resetSinks();
    pottedSeen.clear();
    for (const s of log.shots) {
      runShot(s.shot, s.place, false, s.config ?? log.config); // no rebroadcast
      let steps = 0;
      while (!atRest(world) && steps < 100000) {
        stepFixed(world, events, shotConfig);
        integrateSpin(world, FIXED_DT);
        steps++;
      }
      resolveShot();
    }
    rebuilding = false;
    recomputePrediction();
    bump(0);
  };

  const connect = () => {
    ws = new WebSocket(wsUrl(room));
    ws.onmessage = (ev) => {
      let m: Msg;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      onMsg(m);
    };
    // Auto-reconnect a dropped socket — but not when we're deliberately leaving
    // (resign/navigate away), or the ghost rejoin makes the host re-rack.
    ws.onclose = () => {
      if (!leaving) setTimeout(connect, 1000);
    };
  };

  const onMsg = (m: Msg) => {
    switch (m.t) {
      case "hello": {
        setMySlot(m.slot);
        setPeerCount(m.peers.length + 1);
        // Register my own profile (participants only) and announce it to the room.
        if (m.slot <= 1)
          setProfiles((pr) => ({ ...pr, [m.slot]: myProfile }));
        sendProfile();
        // Whenever anyone else is already here, pull the authoritative state —
        // covers a late joiner AND a reconnect (dropped/suspended socket) where we
        // may have missed any number of shots. The shotCount guard discards it if
        // our own game is actually fresher.
        if (m.peers.length > 0) send({ t: "need-sync" } as Msg);
        recomputePrediction();
        break;
      }
      case "peer-join": {
        setPeerCount((n) => n + 1);
        // Re-announce my profile so the newcomer learns it (the snapshot below
        // carries no identity).
        sendProfile();
        // Opponent just arrived: the host (slot 0) has been knocking balls
        // around solo, so reset to a fresh rack — slot 0 breaks — before syncing.
        // Only on the 1→2 transition; later spectators must not reset the game.
        if (peerCount() === 2 && mySlot() === 0 && !gameStarted) {
          doRematch(0, false);
          announceGameInit(); // start the server's retained log for this game
        }
        // Any active player answers a new joiner with the current (fresh) state;
        // the joiner keeps the freshest snapshot (see the shotCount guard).
        if (mySlot() === 0 || mySlot() === 1) applySnapshotToPeer(m.slot);
        // Snapshot carries no aim, so a joiner sees no cue until someone moves.
        // The active shooter pushes its current aim so the cue shows immediately.
        if (myTurn()) sendAim(world.balls[0].p);
        break;
      }
      case "peer-leave":
        setPeerCount((n) => Math.max(1, n - 1));
        setProfiles((pr) => {
          const n = { ...pr };
          delete n[m.slot];
          return n;
        });
        // If they left mid-draw, drop their finger and let their dangling stroke
        // fade on the normal timeline instead of lingering forever (Infinity).
        delete annot.pointers[m.slot];
        {
          const cur = annot.cur[m.slot];
          if (cur) cur.expireAt = nowMs + DRAW_HOLD_MS;
          annot.cur[m.slot] = undefined;
        }
        break;
      case "profile":
        if (m.from !== undefined)
          setProfiles((pr) => ({ ...pr, [m.from!]: m.profile }));
        break;
      case "need-sync":
        if ((mySlot() === 0 || mySlot() === 1) && m.from !== mySlot())
          applySnapshotToPeer(m.from!);
        break;
      case "sync": {
        // shotCount here is *resolved* shots. Adopt any snapshot that has resolved
        // more than us — this is what tells a backgrounded peer, who applied our
        // last shot but hasn't resolved it (turn still stale), that the turn
        // flipped. Reject equal-or-lower once a game is under way: equal means we
        // agree on resolved state (a still-animating peer of equal resolved count
        // would only send a mid-flight frame). A brand-new joiner (no game yet)
        // still adopts an equal (fresh-rack) snapshot to seed its board.
        if (
          m.snap.shotCount < shotCount ||
          (gameStarted && m.snap.shotCount === shotCount)
        )
          break;
        if (m.snap.balls.length) {
          // Abandon any shot we were still simulating — the snapshot is the
          // authoritative rest state and supersedes it.
          setAnimating(false);
          striking = false;
          lingering = false;
          strikeShot = undefined;
          acc = 0;
          shotCount = m.snap.shotCount;
          gameStarted = true;
          world.balls.forEach((b) => {
            const s = m.snap.balls.find((x) => x.id === b.id);
            if (s) {
              b.p = { x: s.x, y: s.y };
              b.potted = s.potted;
              b.v = { x: 0, y: 0 };
              b.w = { x: 0, y: 0, z: 0 };
            }
          });
          setRules(m.snap.rules as RulesState);
          breaker = m.snap.breaker;
          if (m.snap.config) setConfig(m.snap.config);
          // Don't replay sink animations for balls already down at join time.
          resetSinks();
          world.balls.forEach((b) => b.potted && pottedSeen.add(b.id));
          seedRack(); // show already-potted balls settled in the return track
          recomputePrediction();
        }
        break;
      }
      case "cursor":
        opp.cursor = { x: m.x, y: m.y };
        break;
      case "draw": {
        // A peer is annotating; keep their stream separate (keyed by sender slot)
        // and draw it in their profile colour.
        const from = m.from ?? -1;
        const color = profiles()[from]?.color ?? "#ffe14d";
        const p = m.x !== undefined ? { x: m.x, y: m.y! } : undefined;
        if (m.phase === "start") {
          const stroke = { pts: p ? [p] : [], expireAt: Infinity, color };
          annot.cur[from] = stroke;
          annot.strokes.push(stroke);
          if (p) annot.pointers[from] = { pos: p, color };
        } else if (m.phase === "move") {
          if (p) annot.pointers[from] = { pos: p, color };
          if (p) annot.cur[from]?.pts.push(p);
        } else {
          const cur = annot.cur[from];
          if (cur) cur.expireAt = nowMs + DRAW_HOLD_MS;
          annot.cur[from] = undefined;
          delete annot.pointers[from];
        }
        break;
      }
      case "emoji":
        stamps.push({ ch: m.ch, pos: { x: m.x, y: m.y }, start: nowMs });
        break;
      case "aim":
        opp.aim = {
          angle: m.aim.angle,
          power: m.aim.power,
          follow: m.aim.follow,
          side: m.aim.side,
          elevation: m.aim.elevation ?? 0,
        };
        // Reflect a ball-in-hand drag by the opponent.
        if (rules().ballInHand && rules().turn !== myPlayer()) {
          world.balls[0].p = { ...m.aim.cue };
          world.balls[0].potted = false;
        }
        break;
      case "shot":
        if (m.config) setConfig(m.config);
        // Finish any prior shot first — a backgrounded tab hasn't animated it to
        // rest, and applying this shot over a mid-flight world would diverge.
        settleNow();
        runShot(m.shot, m.place, false, m.config ?? config());
        break;
      case "shot-log":
        // Server handed us the retained game log on (re)join — rebuild exactly.
        rebuildFromLog(m);
        break;
      case "config":
        setConfig(m.config);
        recomputePrediction();
        break;
      case "rematch":
        if (m.config) setConfig(m.config);
        doRematch(m.breaker, false);
        break;
      case "resign":
        applyResign(m.winner);
        break;
    }
  };

  // Forfeit: the resigning player hands the frame to their opponent. Applied
  // locally and broadcast so both tables show the same winner.
  const applyResign = (winner: 0 | 1) => {
    setRules((r) => ({
      ...r,
      winner,
      phase: "over",
      message: `Player ${winner + 1} wins — opponent resigned.`,
    }));
    setReplaying(false);
    showAnnounce(`Player ${winner + 1} wins — opponent resigned.`);
    bump(0);
  };

  const resign = () => {
    const winner = (myPlayer() ^ 1) as 0 | 1;
    send({ t: "resign", winner } as Msg); // hand the frame to the opponent
    setShowMenu(false);
    navigate("/"); // resigner leaves to the main menu
  };

  // --- Shot execution (shared by local + remote) --------------------------
  const runShot = (
    shot: Shot,
    place: Vec | undefined,
    local: boolean,
    cfg: PhysicsConfig,
  ) => {
    if (place) {
      world.balls[0].p = { ...place };
      world.balls[0].potted = false;
    }
    worldBefore = cloneWorld(world);
    events = [];
    applyShot(world, shot);
    // Freeze the config for this shot so live slider changes can't diverge an
    // in-flight simulation; the same config is sent / recorded with the shot.
    shotConfig = cfg;
    history.push({ shot, place, config: cfg });
    totalShots++;
    gameStarted = true;
    setAnimating(true);
    acc = 0;
    bump(0);
    if (local) send({ t: "shot", shot, place, config: cfg } as Msg);
  };

  const resolveShot = () => {
    freeze(world);
    setAnimating(false);
    // Count every *resolved* shot (monotonic — survives a mid-game re-rack). This
    // is what peers compare in the sync guard: a shot that's been applied but not
    // yet resolved (opponent's rAF was paused while backgrounded) must NOT read as
    // caught up, or the stale-turn client rejects the very sync that flips it.
    shotCount++;
    const before = rules();
    const outcome = evaluateShot(before, worldBefore, events);
    if (outcome.reRack) {
      world = rackWorld(seed);
      initialWorld = cloneWorld(world);
      history = [];
      resetSinks();
    }
    // Scratch: bring the cue ball back for ball-in-hand. The cue is un-potted
    // here (before the frame loop could see it), so kick off its sink now — but
    // only if a long shot didn't already start it.
    if (outcome.potted.includes(0) && outcome.next.winner === null) {
      if (!pottedSeen.has(0)) addSink(world.balls[0], nowMs);
      pottedSeen.delete(0); // let a future scratch animate again
      world.balls[0].potted = false;
      world.balls[0].p = { x: TABLE.w * 0.25, y: TABLE.h / 2 };
    }
    setRules(outcome.next);
    // Pop a recap whenever control changes hands or the game ends.
    if (
      !rebuilding &&
      (outcome.next.winner !== null || outcome.next.turn !== before.turn)
    )
      showAnnounce(outcome.next.message);
    pendingPlace = undefined;
    recomputePrediction();
    // Advance the replay queue if we are watching one.
    if (replaying()) queueNextReplayShot();
    bump(0);
  };

  // Fast-forward an in-flight shot to its rest state right now, without waiting
  // for animation frames. requestAnimationFrame is paused/throttled while the tab
  // is backgrounded, so a player who looks away during the opponent's turn would
  // otherwise never advance the sim — and a second incoming shot would stack on a
  // mid-flight world and diverge the game. The sim is fixed-step deterministic
  // (step count set by atRest, not wall-clock), so this reaches the same rest
  // state the animated path would, just instantly and off the render loop.
  const settleNow = () => {
    if (!animating()) return;
    let steps = 0;
    while (!atRest(world) && steps < 100000) {
      stepFixed(world, events, shotConfig);
      integrateSpin(world, FIXED_DT);
      steps++;
    }
    resolveShot();
  };

  // --- Main render / physics loop -----------------------------------------
  const frame = (t: number) => {
    if (!last) last = t;
    let dt = (t - last) / 1000;
    last = t;
    nowMs = t;
    if (dt > 0.1) dt = 0.1; // clamp after a tab stall

    if (striking) {
      const t = Math.min(STRIKE_MS, nowMs - strikeStart);
      // Velocity ramps 0→max over STRIKE_EASE_MS, then holds constant. Distance is
      // the integral of that profile, normalised so it reaches 1 at STRIKE_MS.
      const T1 = STRIKE_EASE_MS;
      const denom = STRIKE_MS - 0.5 * T1;
      const frac =
        t <= T1 ? (0.5 * t * t) / T1 / denom : (t - 0.5 * T1) / denom;
      strikePwr = strikeFromPwr + (STRIKE_POKE - strikeFromPwr) * frac;
      if (t >= STRIKE_MS) finishStrike();
    }
    if (lingering && nowMs >= lingerUntil) lingering = false;

    if (animating()) {
      acc += dt;
      let steps = 0;
      while (acc >= FIXED_DT && steps < 600) {
        stepFixed(world, events, shotConfig);
        integrateSpin(world, FIXED_DT); // roll the surface markings with the shot
        acc -= FIXED_DT;
        steps++;
        if (atRest(world)) break;
      }
      if (atRest(world)) resolveShot();
    }

    // Kick off a sink animation for any ball that just dropped.
    for (const b of world.balls) {
      if (b.potted && !pottedSeen.has(b.id)) {
        pottedSeen.add(b.id);
        addSink(b, t);
        // Collect it in the return track (cue re-spots, never racks). After the
        // pocket-drop it travels UNDER the table to the bottom-left gutter entry —
        // the farther that pocket, the longer before it rolls out into the track.
        if (b.id !== 0 && !rackBalls.some((r) => r.id === b.id)) {
          const hole = nearestHole(b.p);
          const under =
            (Math.hypot(hole.x - GUTTER_ENTRY.x, hole.y - GUTTER_ENTRY.y) /
              UNDER_MPS) *
            1000;
          rackBalls.push({ id: b.id, rollStart: t + SINK_MS + under });
        }
      }
    }
    sinks = sinks.filter((sk) => t - sk.start < SINK_MS);
    // Drop annotation strokes once their hold + self-erase lifetime elapses.
    annot.strokes = annot.strokes.filter((s) => t < s.expireAt + DRAW_ERASE_MS);
    stamps = stamps.filter((s) => t - s.start < STAMP_LIFE);

    draw();
    raf = requestAnimationFrame(frame);
  };
  let raf = 0;

  // Spin-aware shot preview. Recomputed only when an input changes (below),
  // never per-frame — it runs a throwaway sim so it factors in draw/follow,
  // English throw, and rail rebounds.
  const recomputePrediction = () => {
    const cue = world.balls[0];
    if (!canAct() || cue.potted) {
      prediction = undefined;
      return;
    }
    // No power loaded → no preview. Otherwise trace the real spin-aware path at
    // the loaded power.
    const p = power();
    if (p <= 0.01) {
      prediction = undefined;
      return;
    }
    // Powered: trace the whole cue-ball path through cushion rebounds until it
    // hits another ball or comes to rest.
    const shot: Shot = {
      angle: aimAngle,
      power: p,
      follow: follow(),
      side: side(),
      elevation: elevation(),
    };
    prediction = predictPaths(world, shot, config(), 5, false);
  };

  const draw = () => {
    const r = rules();
    // The canvas fills the whole game area; the felt sits wherever the table-wrap
    // spacer landed in the flex row. offsetLeft/Top are in the untransformed
    // layout frame (ignore the rot90 CSS transform), so they map straight to
    // canvas-local px — recentre the world origin onto it each frame.
    layout.ox = layoutBase.ox + tableWrap.offsetLeft;
    layout.oy = layoutBase.oy + tableWrap.offsetTop;
    const myGroup = r.groups[myPlayer()];
    // Shooter is "on the 8" once every ball of their group is potted — only then
    // is the black a legal first target.
    const onEight =
      myGroup !== null &&
      !world.balls.some((b) => !b.potted && groupOf(b.id) === myGroup);
    const aim: Aim = {
      angle: aimAngle,
      power: power(),
      follow: follow(),
      side: side(),
      elevation: elevation(),
    };
    // During the cue-forward strike the physics animates the cue; suppress the
    // canvas aim line + guide so only the moving cue shows.
    const live = canAct() && !striking;
    // The on-table cue: the live shot during the swing/linger, the own aim while
    // it's our turn, or the opponent's mirrored blue cue on theirs.
    const cb = world.balls[0];
    let cue: CueDraw | undefined;
    if ((striking || lingering) && !cb.potted) {
      cue = {
        at: strikeCuePos ?? cb.p, angle: aimAngle, power: strikePwr,
        elevation: strikeElev, side: strikeSide, follow: strikeFollow, band: myBand(),
      };
    } else if (canAct() && !animating() && !cb.potted) {
      cue = {
        at: cb.p, angle: aimAngle, power: power(), elevation: elevation(),
        side: side(), follow: follow(), band: myBand(),
      };
    } else if (!canAct() && !animating() && !cb.potted && opp.aim) {
      cue = {
        at: cb.p, angle: opp.aim.angle, power: opp.aim.power,
        elevation: opp.aim.elevation, side: opp.aim.side, follow: opp.aim.follow,
        band: oppBand(),
      };
    }
    drawScene(ctx, {
      world,
      layout,
      myAim: live ? aim : undefined,
      prediction: live ? prediction : undefined,
      showCue: live,
      ballInHand: live && r.ballInHand, // cue ball fades to 0.55
      growCue: placeMode, // enlarge the cue ball while it's grabbed for placement
      cue,

      myGroup,
      onEight,
      opponent: opp,
      pointers: Object.values(annot.pointers),
      // Whole line through the hold, then erase from start→release: `erase` is the
      // fraction of the path length (from the start) already wiped away.
      strokes: annot.strokes.map((s) => ({
        pts: s.pts,
        color: s.color,
        erase:
          nowMs < s.expireAt
            ? 0
            : Math.min(1, (nowMs - s.expireAt) / DRAW_ERASE_MS),
      })),
      emojis: stamps.map((s) => ({
        ch: s.ch,
        pos: s.pos,
        scale: stampScale(nowMs - s.start),
      })),
      animating: animating(),
      debug: debug(),
      sinks: sinks.map((sk) => ({
        id: sk.id,
        from: sk.from,
        pocket: sk.pocket,
        v: sk.v,
        ms: nowMs - sk.start,
        o0: sk.o0,
      })),
      rack: rackBalls,
      now: nowMs,
      debugCursor: debug() ? debugCursor : undefined,
      debugCopied: debug() && nowMs - debugCopiedAt < 900,
    });
  };

  // Cue colours: a wood shaft, a coloured wrap, then a black butt. The wrap hue is
  // each player's chosen colour (from their profile); the stick is drawn on the
  // main canvas by render.ts (drawCue). Fall back to a neutral blue for a peer
  // whose profile hasn't arrived yet.
  const CUE_BLUE = { dark: "#1d3f74", light: "#356ac0" };
  const myBand = () => cueBand(myProfile.color);
  const oppBand = () => {
    const p = profiles()[1 - myPlayer()];
    return p ? cueBand(p.color) : CUE_BLUE;
  };
  // Power-widget cue sprite in my colour (my profile is fixed for the session, so
  // build it once). Matches the on-table cue instead of a static red PNG.
  const cueSprite = cueSpriteDataURL(myBand());

  // --- Pointer input ------------------------------------------------------
  // Screen point -> an element's own (un-rotated) local pixel space, plus that
  // element's local width/height. When the game root is CSS-rotated 90° (a
  // portrait phone held sideways) we invert the rotation here, so every widget's
  // math stays in its natural landscape frame. rotate(90deg) maps a local vector
  // (a,b) to screen (-b, a); inverse: (a,b) = (sy, -sx).
  const localPoint = (el: Element, e: PointerEvent) => {
    const r = el.getBoundingClientRect();
    const sx = e.clientX - (r.left + r.width / 2);
    const sy = e.clientY - (r.top + r.height / 2);
    if (rot90()) {
      const w = r.height, h = r.width; // bbox is the 90°-rotated local box
      return { x: w / 2 + sy, y: h / 2 - sx, w, h };
    }
    return { x: r.width / 2 + sx, y: r.height / 2 + sy, w: r.width, h: r.height };
  };

  const toWorld = (e: PointerEvent): Vec => {
    const p = localPoint(canvas, e);
    const px = (p.x / p.w) * layout.W;
    const py = (p.y / p.h) * layout.H;
    return { x: (px - layout.ox) / layout.scale, y: (py - layout.oy) / layout.scale };
  };

  // Inverse of toWorld: a world point → canvas-local CSS px (the un-rotated frame
  // localPoint reports in), for pinning DOM overlays like the spin window.
  const worldToLocal = (p: Vec) => {
    const r = canvas.getBoundingClientRect();
    const w = rot90() ? r.height : r.width; // un-rotated dims (see localPoint)
    const h = rot90() ? r.width : r.height;
    return {
      x: ((layout.ox + p.x * layout.scale) / layout.W) * w,
      y: ((layout.oy + p.y * layout.scale) / layout.H) * h,
    };
  };

  const clampCue = (p: Vec): Vec => {
    // Keep the ball on the felt: the playfield is inset from the table edge by
    // RAIL_INSET, and the ball touches a rail when its centre is R away.
    const m = RAIL_INSET + R;
    let x = Math.max(m, Math.min(TABLE.w - m, p.x));
    let y = Math.max(m, Math.min(TABLE.h - m, p.y));
    // Keep the ball centre clear of every pocket hole so it can't be placed in
    // (or half-hanging over) a pocket.
    for (const pk of POCKET_LIST) {
      const dx = x - pk.center.x;
      const dy = y - pk.center.y;
      const d = Math.hypot(dx, dy);
      const min = pk.hole + R;
      if (d < min && d > 1e-6) {
        x = pk.center.x + (dx / d) * min;
        y = pk.center.y + (dy / d) * min;
      }
    }
    // Push out of any overlapping object ball.
    for (const b of world.balls) {
      if (b.potted || b.id === 0) continue;
      const dx = x - b.p.x;
      const dy = y - b.p.y;
      const d = Math.hypot(dx, dy);
      if (d < 2 * R && d > 1e-6) {
        x = b.p.x + (dx / d) * 2 * R;
        y = b.p.y + (dy / d) * 2 * R;
      }
    }
    return { x, y };
  };

  // The cue aims AT the point: the ball fires toward it (jitter-guarded).
  const aimFromCursor = (target: Vec, cue: Vec) => {
    const dx = target.x - cue.x;
    const dy = target.y - cue.y;
    if (Math.hypot(dx, dy) > R * 1.2) aimAngle = Math.atan2(dy, dx);
  };

  const wrapPi = (d: number) => {
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return d;
  };

  const sendAim = (cue: Vec) => {
    send({
      t: "aim",
      aim: {
        angle: aimAngle,
        power: power(),
        follow: follow(),
        side: side(),
        elevation: elevation(),
        cue: cue,
      },
    } as Msg);
  };

  const sendPresence = (w: Vec, cue: Vec) => {
    const now = performance.now();
    if (now - lastPresence <= 1000 / 60) return; // 60Hz — smooth remote aim
    lastPresence = now;
    send({ t: "cursor", x: w.x, y: w.y } as Msg);
    sendAim(cue);
  };

  // --- Table annotation (comm mode) ---------------------------------------
  // With comm mode on, our canvas pointer draws instead of aiming: touch shows a
  // pointing finger on the other table, drag leaves a dotted path. `draw` msgs.
  // My own annotation stream is keyed by my slot (0 in solo, before `hello`).
  const myDrawKey = () => (mySlot() < 0 ? 0 : mySlot());
  const startDraw = (e: PointerEvent) => {
    const w = toWorld(e);
    const k = myDrawKey();
    drawing = true;
    const stroke = { pts: [w], expireAt: Infinity, color: myProfile.color };
    annot.cur[k] = stroke;
    annot.strokes.push(stroke);
    annot.pointers[k] = { pos: w, color: myProfile.color };
    lastDraw = 0;
    hitEl.setPointerCapture(e.pointerId);
    send({ t: "draw", phase: "start", x: w.x, y: w.y } as Msg);
  };
  const moveDraw = (e: PointerEvent) => {
    const w = toWorld(e);
    const k = myDrawKey();
    annot.pointers[k] = { pos: w, color: myProfile.color };
    annot.cur[k]?.pts.push(w); // append locally every move (smooth line)
    const now = performance.now();
    if (now - lastDraw <= 30) return; // throttle only the network stream
    lastDraw = now;
    send({ t: "draw", phase: "move", x: w.x, y: w.y } as Msg);
  };
  const endDraw = () => {
    if (!drawing) return;
    drawing = false;
    const k = myDrawKey();
    const cur = annot.cur[k];
    if (cur) cur.expireAt = nowMs + DRAW_HOLD_MS;
    annot.cur[k] = undefined;
    delete annot.pointers[k];
    send({ t: "draw", phase: "end" } as Msg);
  };

  // --- Emoji tray drag ----------------------------------------------------
  // Press an emoji in the tray and drag it onto the felt; on release it spawns a
  // temporary animated stamp there (locally + broadcast). A fixed floating preview
  // follows the finger during the drag (screen space, so it ignores the rot90).
  const spawnStamp = (ch: string, pos: Vec) => {
    stamps.push({ ch, pos, start: nowMs });
    send({ t: "emoji", ch, x: pos.x, y: pos.y } as Msg);
  };
  const moveDragEl = (e: PointerEvent) => {
    dragEl.style.left = `${e.clientX}px`;
    dragEl.style.top = `${e.clientY}px`;
  };
  const onTrayDown = (ch: string, e: PointerEvent) => {
    if (cueDragTakeover(e)) return; // cue overhangs the tray → drag the cue
    e.preventDefault();
    dragCh = ch;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragEl.textContent = ch;
    dragEl.style.display = "block";
    moveDragEl(e);
  };
  const onTrayMove = (e: PointerEvent) => {
    if (dragCh) moveDragEl(e);
  };
  const onTrayUp = (e: PointerEvent) => {
    if (!dragCh) return;
    const ch = dragCh;
    dragCh = "";
    dragEl.style.display = "none";
    // Spawn the stamp wherever it was released — no clamp to the table, so it can
    // sit anywhere on the (full-screen) felt, including off the playfield.
    spawnStamp(ch, toWorld(e));
  };

  // Dragging an emoji out of the "more" picker: same floating preview, but on
  // release it either swaps a quick-tray slot (dropped on the tray) or stamps the
  // table (dropped anywhere else).
  const onPickerDown = (ch: string, e: PointerEvent) => {
    e.preventDefault();
    dragCh = ch;
    // Capture stays on this element (kept mounted) so hiding the modal doesn't
    // break the drag — the picker just fades out until release.
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setPickerDragging(true);
    dragEl.textContent = ch;
    dragEl.style.display = "block";
    moveDragEl(e);
  };
  const onPickerUp = (e: PointerEvent) => {
    setPickerDragging(false);
    if (!dragCh) return;
    const ch = dragCh;
    dragCh = "";
    dragEl.style.display = "none";
    const slot = traySlotAt(e.clientX, e.clientY);
    if (slot >= 0) {
      swapQuick(slot, ch); // dropped onto the quick tray → swap that slot
      return;
    }
    spawnStamp(ch, toWorld(e)); // dropped on the felt → stamp it
  };

  // Classify a canvas press into one of four gestures by *where* it lands:
  //  - on the cue ball  → spin (swipe away opens the floating window); during
  //    ball-in-hand a 1s hold-without-swipe instead grabs the ball to reposition.
  //  - on the cue stick → cue elevation (drag along the axis, toward/away).
  //  - anywhere else     → aim (tap snaps, drag fine-tunes) — unchanged.
  const onPointerDown = (e: PointerEvent) => {
    if (debug()) {
      const w = toWorld(e); // copy world coords for tuning pocket polygons
      const s = `[${w.x.toFixed(3)}, ${w.y.toFixed(3)}]`;
      navigator.clipboard?.writeText(s);
      debugCopiedAt = nowMs; // flash "copied" in the readout
    }
    if (canPoint()) return startDraw(e); // waiting: annotate instead of aim
    if (!canAct() || striking) return;
    const w = toWorld(e);
    const cue = world.balls[0].p;
    downClient = { x: e.clientX, y: e.clientY };
    downWorld = w;
    aimStart = aimAngle;
    downFinger = Math.atan2(w.y - cue.y, w.x - cue.x);
    lastFinger = downFinger;
    aimAccum = 0;
    movedFar = false;
    const onCueBall = Math.hypot(w.x - cue.x, w.y - cue.y) < R * 2.55;
    // Project the press onto the cue axis (the stick lies opposite the aim).
    const back = aimAngle + Math.PI;
    const proj = (w.x - cue.x) * Math.cos(back) + (w.y - cue.y) * Math.sin(back);
    const perp = -(w.x - cue.x) * Math.sin(back) + (w.y - cue.y) * Math.cos(back);
    const onCueStick =
      !onCueBall &&
      proj > STICK_NEAR && proj < STICK_FAR && Math.abs(perp) < STICK_PERP;

    // The hit-layer reaches past the canvas so an overhanging cue stick is
    // grabbable — but a press out there that ISN'T on the stick (or ball) is just
    // empty margin: ignore it so it can't snap the aim to a point off-table.
    const cr = canvas.getBoundingClientRect();
    const offCanvas =
      e.clientX < cr.left || e.clientX > cr.right ||
      e.clientY < cr.top || e.clientY > cr.bottom;
    if (offCanvas && !onCueBall && !onCueStick) return;

    if (onCueBall) {
      mode = "spin";
      spinDownLocal = localPoint(canvas, e);
      // Ball-in-hand: hold still for LONGPRESS_MS to switch from spin to grabbing
      // the ball. A swipe (movedFar) cancels this timer in onPointerMove.
      if (rules().ballInHand) {
        lpTimer = setTimeout(() => {
          mode = "place";
          placeMode = true;
          setShowSpinHud(false);
        }, LONGPRESS_MS);
      }
    } else if (onCueStick) {
      mode = "elev";
      elevStart = elevation();
      projStart = proj;
    } else {
      mode = "aim";
    }
    hitEl.setPointerCapture(e.pointerId);
  };

  // True if a press lands on the cue ball or the overhanging cue stick while it's
  // ours to aim. UI widgets call this so a cue drag over them wins: they hand the
  // gesture to the table (onPointerDown captures hitEl) instead of acting.
  const isOnCueDrag = (e: PointerEvent): boolean => {
    if (!canAct() || striking) return false;
    const cb = world.balls[0];
    if (cb.potted) return false;
    const w = toWorld(e);
    const cue = cb.p;
    if (Math.hypot(w.x - cue.x, w.y - cue.y) < R * 2.55) return true; // cue ball
    const back = aimAngle + Math.PI;
    const proj = (w.x - cue.x) * Math.cos(back) + (w.y - cue.y) * Math.sin(back);
    const perp = -(w.x - cue.x) * Math.sin(back) + (w.y - cue.y) * Math.cos(back);
    return proj > STICK_NEAR && proj < STICK_FAR && Math.abs(perp) < STICK_PERP;
  };

  // A UI widget's pointerdown: if the press is really on the cue, redirect the
  // gesture to the table (the cue always wins over whatever's under it) and
  // swallow it here so the button/power widget/tray won't also act. Returns true
  // when it took over. `.preventDefault()` stops the follow-up click on a button.
  const cueDragTakeover = (e: PointerEvent): boolean => {
    if (!isOnCueDrag(e)) return false;
    e.preventDefault();
    onPointerDown(e); // captures hitEl → subsequent move/up route to the table
    return true;
  };

  const onPointerMove = (e: PointerEvent) => {
    if (debug()) debugCursor = toWorld(e); // live world-coord readout
    if (drawing) return moveDraw(e);
    if (!canAct() || !mode) return;
    const w = toWorld(e);
    const cue = world.balls[0];
    if (Math.hypot(e.clientX - downClient.x, e.clientY - downClient.y) > TAP_PX)
      movedFar = true;

    if (mode === "spin") {
      if (!movedFar) return; // a still finger might yet become a ball-in-hand grab
      clearTimeout(lpTimer); // committed to a spin swipe — no reposition
      setSpinHudPos(worldToLocal(cue.p)); // centre the window on the cue ball
      setSpinAim(aimAngle); // orient the pad to the current cue direction
      setShowSpinHud(true);
      const lp = localPoint(canvas, e);
      const dx = (lp.x - spinDownLocal.x) / SPIN_REACH_PX;
      const dy = (lp.y - spinDownLocal.y) / SPIN_REACH_PX;
      // Decompose the swipe in the CUE's frame: along the aim line = draw/follow,
      // across it = english. So the pad tracks the cue however it's pointed.
      const a = aimAngle;
      let f = dx * Math.cos(a) + dy * Math.sin(a); // toward the aim = follow (+)
      let s = -dx * Math.sin(a) + dy * Math.cos(a); // perpendicular = side english
      const r = Math.hypot(f, s); // clamp to the miscue (unit) circle
      if (r > 1) { f /= r; s /= r; }
      setFollow(f);
      setSide(s);
      recomputePrediction();
      return;
    }
    if (mode === "place") {
      cue.p = clampCue(w);
    } else if (mode === "elev") {
      // Grabbing the stick both raises the cue AND still swings the aim, so it
      // never feels locked. Aim tracks the finger 1:1 (unlike felt-drag's slowed
      // AIM_GAIN), so the handle follows the hand — do this FIRST so elevation
      // projects onto the freshly-rotated cue axis.
      const finger = Math.atan2(w.y - cue.p.y, w.x - cue.p.x);
      if (movedFar && Math.hypot(w.x - cue.p.x, w.y - cue.p.y) > R) {
        aimAccum += wrapPi(finger - lastFinger); // integrate small deltas, no wrap snap
        lastFinger = finger;
        aimAngle = aimStart + aimAccum;
      }
      // Keep the finger over the same point on the cue as it rears. A cue point
      // at along-axis distance d foreshortens to d·cos(elev) on the table, so
      // holding that point under the finger gives cos(elev) = proj·cos(elevStart)
      // / projStart, where proj is measured along the CURRENT (rotated) cue axis.
      // Grab near the butt (big projStart) → a longer drag to reach full angle;
      // grab near the tip (small projStart) → a short one.
      const back = aimAngle + Math.PI;
      const proj = (w.x - cue.p.x) * Math.cos(back) + (w.y - cue.p.y) * Math.sin(back);
      const ratio = projStart > 0 ? (proj * Math.cos(elevStart)) / projStart : 1;
      const el = Math.acos(Math.max(Math.cos(MAX_ELEVATION), Math.min(1, ratio)));
      setElevation(el);
    } else if (movedFar) {
      // Fine aim: rotate the shot about the cue ball by a fraction of the
      // finger's swing (slower than the finger, for precision).
      const finger = Math.atan2(w.y - cue.p.y, w.x - cue.p.x);
      if (Math.hypot(w.x - cue.p.x, w.y - cue.p.y) > R) {
        aimAccum += wrapPi(finger - lastFinger); // integrate small deltas, no wrap snap
        lastFinger = finger;
        aimAngle = aimStart + aimAccum * AIM_GAIN;
      }
    }
    recomputePrediction();
    sendPresence(w, cue.p);
  };

  const onPointerUp = () => {
    if (drawing) return endDraw();
    clearTimeout(lpTimer);
    if (!mode) return;
    const m = mode;
    mode = null;
    if (m === "spin") {
      setShowSpinHud(false); // window vanishes the instant the drag ends
      recomputePrediction();
      return;
    }
    if (m === "place") {
      placeMode = false;
      pendingPlace = { ...world.balls[0].p };
      recomputePrediction();
      return;
    }
    if (m === "elev") {
      recomputePrediction();
      return;
    }
    // Tap the felt → snap aim there; a drag already fine-tuned the aim.
    if (!movedFar) {
      aimFromCursor(downWorld, world.balls[0].p);
      // A tap never fires onPointerMove, so sync the new aim to the opponent.
      lastPresence = 0; // bypass the presence throttle for this one-off update
      sendPresence(downWorld, world.balls[0].p);
    }
    recomputePrediction();
  };

  // --- Cue power widget (vertical cue left of the table) ------------------
  // Drag the cue back (down) to load power; release to strike.
  let powerEl!: SVGSVGElement;
  let pulling = false;
  let pullStartY = 0;
  const onPowerDown = (e: PointerEvent) => {
    if (cueDragTakeover(e)) return; // cue overhangs the widget → drag the cue
    if (!canAct() || striking) return;
    powerEl.setPointerCapture(e.pointerId);
    pulling = true;
    // Anchor so the current finger maps to the already-loaded power — a redrag
    // continues from where the last one left off instead of snapping to 0.
    const lp = localPoint(powerEl, e); // widget-local, survives 90° rotation
    pullStartY = lp.y - power() * (lp.h * 0.6);
  };
  const onPowerMove = (e: PointerEvent) => {
    if (!pulling) return;
    const p = localPoint(powerEl, e);
    const dy = p.y - pullStartY; // pull down (toward the butt) = load
    setPower(Math.max(0, Math.min(1, dy / (p.h * 0.6))));
    recomputePrediction();
    sendPresence(world.balls[0].p, world.balls[0].p);
  };
  const onPowerUp = () => {
    if (!pulling) return;
    pulling = false;
    // Power stays loaded on release; the shot only fires via the Shoot button.
    recomputePrediction();
  };
  // 10-segment power gauge behind the cue (viewBox 40×200). It spans the exact
  // band the cue tip travels (powerTipY: 8 at rest → 118 at full); each segment
  // is revealed once the cue is drawn past its level, so the stack of visible
  // blocks grows top→bottom with power. Colours are a static yellow (soft, top)
  // → red (hard, bottom) gradient.
  const POWER_SEG_N = 10;
  const POWER_SEG_TOP = 2;
  const POWER_SEG_SPAN = 110;
  const POWER_SEG_GAP = 2;
  // N gaps (N-1 between segments + 1 trailing) so there's a segment-sized gap
  // between the last segment and the max cue-drag distance.
  const POWER_SEG_H =
    (POWER_SEG_SPAN - POWER_SEG_N * POWER_SEG_GAP) / POWER_SEG_N;
  const POWER_SEG_COLORS = Array.from({ length: POWER_SEG_N }, (_, i) => {
    const t = i / (POWER_SEG_N - 1); // 0 = yellow, 1 = red
    return `rgb(${Math.round(232 - 8 * t)}, ${Math.round(212 - 140 * t)}, ${Math.round(77 - 19 * t)})`;
  });

  // Cue image (tip at very top, butt at bottom), square with transparent margins.
  // `cueSprite` is generated above from rodBitmap in the player's own colour.
  const CUE_S = 250; // square draw size in the 40×200 viewBox (bigger = thicker)
  const CUE_TIP_FRAC = 0; // tip sits at the top edge of the source image
  // Tip sits just under the spin ball (top) and slides down as power loads.
  const powerTipY = () => 2 + power() * 110;
  const cueImgY = () => powerTipY() - CUE_TIP_FRAC * CUE_S;

  // --- Actions ------------------------------------------------------------
  // Cue-forward animation on release: the on-table cue slides from its pulled-
  // back gap into the ball over STRIKE_MS before the physics fires, so a strike
  // reads as the cue actually hitting rather than the ball leaping on its own.
  const STRIKE_MS = 100; // total cue-forward travel time
  const STRIKE_EASE_MS = 90; // accelerate over this long, then constant velocity
  const STRIKE_POKE = -0.13; // final "power" the cue drives to (tip pokes the ball)
  const STRIKE_LINGER_MS = 400; // hold the cue at contact this long after the swing
  let striking = false;
  let lingering = false;
  let lingerUntil = 0;
  let strikeStart = 0;
  let strikeFromPwr = 0;
  let strikePwr = 0;
  let strikeShot: Shot | undefined;
  let strikePlace: Vec | undefined;
  let strikeCuePos: Vec | undefined; // frozen contact point for the linger
  let strikeElev = 0; // frozen cue angle for the swing/linger (elevation() resets)
  let strikeSide = 0; // frozen english for the swing/linger (side() resets)
  let strikeFollow = 0; // frozen follow/draw for the swing/linger

  // Swing done: fire the physics, but keep the cue drawn at the contact point
  // for STRIKE_LINGER_MS so it doesn't blink out the instant the ball leaves.
  const finishStrike = () => {
    striking = false;
    if (strikeShot) runShot(strikeShot, strikePlace, true, config());
    strikeShot = undefined;
    setPower(0); // reset power between shots
    setSide(0); // clear english + cue elevation so the next shot starts neutral
    setFollow(0);
    setElevation(0);
    lingering = true;
    lingerUntil = nowMs + STRIKE_LINGER_MS;
  };

  const shoot = () => {
    if (!canAct() || striking || power() <= 0) return;
    // On a ball-in-hand turn, lock in wherever the cue currently sits.
    const place =
      rules().ballInHand ? pendingPlace ?? { ...world.balls[0].p } : undefined;
    strikeShot = {
      angle: aimAngle,
      power: power(),
      follow: follow(),
      side: side(),
      elevation: elevation(),
    };
    strikePlace = place;
    strikeCuePos = place ? { ...place } : { ...world.balls[0].p };
    strikeElev = elevation(); // hold the angle through the swing + linger
    strikeSide = side(); // hold the english/draw through the swing + linger
    strikeFollow = follow();
    strikeFromPwr = power(); // strike starts from the live pulled-back cue
    strikePwr = strikeFromPwr;
    strikeStart = nowMs;
    striking = true;
  };

  const doRematch = (nextBreaker: 0 | 1, local: boolean) => {
    world = rackWorld(seed);
    initialWorld = cloneWorld(world);
    history = [];
    shotCount = 0;
    totalShots = 0;
    gameStarted = true;
    breaker = nextBreaker;
    setRules(initRules(nextBreaker));
    setReplaying(false);
    pendingPlace = undefined;
    resetSinks();
    if (local) {
      send({ t: "rematch", breaker: nextBreaker, config: config() } as Msg);
      announceGameInit(); // seed the server's retained log for the new game
    }
    recomputePrediction();
    bump(0);
  };

  // --- Replay -------------------------------------------------------------
  const saveReplay = () => {
    const r = buildReplay(
      breaker,
      initialWorld,
      history,
      { w: TABLE.w, h: TABLE.h },
      config(),
    );
    downloadReplay(r);
  };

  const queueNextReplayShot = () => {
    const next = replayQueue.shift();
    if (!next) {
      setReplaying(false);
      return;
    }
    const cfg = next.config ?? config();
    setTimeout(() => {
      setConfig(cfg);
      runShot(next.shot, next.place, false, cfg);
    }, 700);
  };

  const playReplay = (r: Replay) => {
    world = worldFromInitial(r.initial);
    initialWorld = cloneWorld(world);
    history = [];
    shotCount = 0;
    totalShots = 0;
    breaker = r.breaker;
    setConfig(r.config);
    resetSinks();
    setRules(initRules(r.breaker));
    replayQueue = [...r.shots];
    setReplaying(true);
    bump(0);
    queueNextReplayShot();
  };


  // --- Lifecycle ----------------------------------------------------------
  onMount(() => {
    ctx = canvas.getContext("2d")!;
    const resize = () => {
      // Portrait phones get the table turned 90° so the long axis runs down
      // the screen; everything else stays landscape.
      // A portrait phone is played held SIDEWAYS: we lay the table out landscape
      // and CSS-rotate the whole game root 90°, so measure against the SWAPPED
      // viewport. Everything else (tablet/desktop) stays upright landscape.
      const rotate90 =
        window.innerHeight > window.innerWidth && window.innerWidth < 700;
      setRot90(rotate90);
      const vw = rotate90 ? window.innerHeight : window.innerWidth;
      const vh = rotate90 ? window.innerWidth : window.innerHeight;
      // Fit the whole table PHOTO (felt + wooden rails) into the viewport minus
      // the two side columns. They're equal-width (grid 1fr each) and must hold
      // their widget (the 78px shoot button / 76px cue) with breathing room, so
      // reserve that on both sides — the table then centres exactly between them.
      const COL_W = 90; // per-side reserve (each 1fr column is at least this wide)
      const unit = layoutFor(1, false); // always landscape
      const availW = vw - COL_W * 2;
      // Reserve the ball-return gutter's height (unit.gutter) as the BOTTOM gap,
      // mirrored on top, so the table centres with an equal gap on each side and
      // the gutter fills the bottom gap. Height-limited: table + 2 gaps = vh.
      let scale = Math.min(availW / unit.W, vh / (unit.H + 2 * unit.gutter));
      scale = Math.max(40, Math.min(scale, 430));
      layoutBase = layoutFor(scale, false); // the felt box (W/H/ox/oy)
      // Spacer = table image only; the gutter overflows the spacer downward into
      // the bottom gap. Banner sits centred in the (equal) top gap.
      setTableW(layoutBase.W);
      setTableH(layoutBase.H);
      setCanvasH(layoutBase.H);
      setBannerTop((vh - layoutBase.H) / 4);
      // The canvas itself fills the whole game area (vw × vh, the swapped viewport
      // under rot90) so the cue can be drawn wherever it overhangs the felt. The
      // world origin is recentred onto the spacer each frame in draw().
      const dpr = window.devicePixelRatio || 1;
      canvas.width = vw * dpr;
      canvas.height = vh * dpr;
      canvas.style.width = `${vw}px`;
      canvas.style.height = `${vh}px`;
      layout = { ...layoutBase, W: vw, H: vh };
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);
    // Press "d" to toggle the collision-geometry debug overlay.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "d" && !e.metaKey && !e.ctrlKey && !e.altKey)
        setDebug((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    const onFsChange = () => {
      setFullscreen(!!document.fullscreenElement);
      resize(); // viewport dimensions change entering/leaving fullscreen
    };
    document.addEventListener("fullscreenchange", onFsChange);
    // Returning to a backgrounded tab: (1) settle any shot that ran to rest
    // off-screen so our local state is consistent, then (2) pull the opponent's
    // authoritative state — shots played while our socket was suspended were never
    // delivered (the server keeps no history), so a resync is the only way to
    // reconcile them. The shotCount guard ignores it if we're not actually behind.
    const onVisible = () => {
      if (document.hidden) return;
      settleNow();
      if (!solo()) send({ t: "need-sync" } as Msg);
    };
    document.addEventListener("visibilitychange", onVisible);
    // A replay picked on the Landing menu is stashed and consumed here.
    const pend = takePendingReplay();
    if (pend) playReplay(pend);
    connect();
    raf = requestAnimationFrame(frame);

    onCleanup(() => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("fullscreenchange", onFsChange);
      document.removeEventListener("visibilitychange", onVisible);
      leaving = true;
      ws?.close();
    });
  });

  // Dot offset: ±1 slider sits at half the ball radius (the miscue ring). The
  // pad's drawn radius is 50% of its box, so a full slider is 25% off centre.
  const spinDot = () => ({
    left: `${50 + side() * 25}%`,
    top: `${50 - follow() * 25}%`,
  });

  // Decorative training-ball face (red edge rings, black crosshair, HL/HR/…
  // labels, red centre emblem). Shared by every spin widget; the live .dot sits
  // on top. Labels stay upright — the widget itself rotates to the cue's aim.
  const SpinFace: Component = () => (
    <svg class="spin-face" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet">
      <circle cx="50" cy="50" r="48" class="sf-red" />
      <circle cx="50" cy="50" r="35" class="sf-black" />
      <line x1="50" y1="26" x2="50" y2="74" class="sf-cross" />
      <line x1="26" y1="50" x2="74" y2="50" class="sf-cross" />
      {SPIN_DIRS.map(([dx, dy, label]) => {
        const rr = dx && dy ? 26 : 30; // cardinals sit out near the ring
        return (
          <text x={50 + dx * rr} y={50 + dy * rr} class="sf-label">
            {label}
          </text>
        );
      })}
      <circle cx="50" cy="50" r="7" class="sf-black" />
      <circle cx="50" cy="50" r="3" class="sf-emblem" />
    </svg>
  );

  return (
    <div class="game-root" classList={{ rot90: rot90() }}>
      {/* Full-screen table canvas (felt, balls, cue stick, aim lines). The felt is
          drawn onto the .table-spacer's slot; the cue can overhang anywhere. */}
      <canvas class="table-canvas" ref={canvas} onContextMenu={(e) => e.preventDefault()} />
      {/* Transparent pointer layer over the whole table; widgets sit above it. */}
      <div
        class="table-hit"
        ref={hitEl}
        onPointerMove={onPointerMove}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onContextMenu={(e) => e.preventDefault()}
      />
      {/* Floating spin window — pops up at the finger while dragging off the cue
          ball, gone on release. In game-root (canvas-local frame) so it rides the
          rot90 transform and shares the frame the drag maps in. */}
      <Show when={showSpinHud()}>
        <div
          class="spin-hud"
          style={{
            left: `${spinHudPos().x}px`,
            top: `${spinHudPos().y}px`,
            transform: `translate(-50%, -50%) rotate(${spinAim() + Math.PI / 2}rad)`,
          }}
        >
          <div class="spin">
            <SpinFace />
            <div class="dot" style={spinDot()} />
          </div>
        </div>
      </Show>

      {/* Player banner above the table: emoji + name per connected player, in
          their cue colour. Centred when solo, split by "vs" when two are in. */}
      <Show when={roster().length > 0}>
        <div class="player-banner" style={{ top: `${bannerTop()}px` }}>
          <For each={roster()}>
            {(pl, i) => (
              <>
                <Show when={i() > 0}>
                  <span class="pb-vs">vs</span>
                </Show>
                <div class="pb-chip" style={{ "border-color": pl.color }}>
                  <span class="pb-emoji">{pl.emoji}</span>
                  <span class="pb-name" style={{ color: pl.color }}>
                    {pl.name}
                  </span>
                </div>
              </>
            )}
          </For>
        </div>
      </Show>

      <Show when={announce()}>
        <div class="turn-recap">{announce()}</div>
      </Show>

      {/* Floating emoji preview that follows the finger during a tray drag.
          Portaled to <body> so it stays in true screen space — inside the
          rot90-transformed game root, a position:fixed child would be offset. */}
      <Portal>
        <div class="emoji-drag" ref={dragEl} />
      </Portal>

      {/* 3-column layout: equal-width side columns (1fr each) flank the
          content-sized table column, so the table is always screen-centred. The
          full-screen canvas behind this draws the felt over the table-spacer's
          slot and lets the cue overhang anywhere. */}
      <div class="play-row">
        {/* Left column: back menu (top) + emoji/comm dock (bottom). */}
        <div class="left-col">
          <button
            class="hamburger"
            title="menu"
            onPointerDown={cueDragTakeover}
            onClick={() => setShowMenu(true)}
          >
            ☰
          </button>
        </div>

        {/* Empty spacer reserving the felt's footprint so the side widgets lay
            out beside it; the canvas draws the felt over this slot. */}
        <div
          class="table-spacer"
          ref={tableWrap}
          style={{ width: `${tableW()}px`, height: `${tableH()}px` }}
        />

        <div class="cue-col">
          {/* Fire the loaded shot — a pool-ball button at the top of the column,
              horizontally centred over the cue. */}
          <Show when={myTurn()}>
            <button
              class="shoot-btn"
              title="shoot"
              disabled={!canAct() || striking || power() <= 0}
              onPointerDown={cueDragTakeover}
              onClick={shoot}
            >
              <span class="ball-label">
                {/* Target reticle — aim & shoot. */}
                <svg class="shoot-ico" viewBox="0 0 24 24" aria-label="shoot">
                  <circle
                    cx={12}
                    cy={12}
                    r={7.5}
                    fill="none"
                    stroke="currentColor"
                    stroke-width={2}
                  />
                  <line x1={12} y1={0.5} x2={12} y2={5} stroke="currentColor" stroke-width={2} />
                  <line x1={12} y1={19} x2={12} y2={23.5} stroke="currentColor" stroke-width={2} />
                  <line x1={0.5} y1={12} x2={5} y2={12} stroke="currentColor" stroke-width={2} />
                  <line x1={19} y1={12} x2={23.5} y2={12} stroke="currentColor" stroke-width={2} />
                  <circle cx={12} cy={12} r={2.2} fill="currentColor" />
                </svg>
              </span>
            </button>
          </Show>
          {/* Cue power — fills the remaining height; pull back to load. The
              10-segment bar behind the cue reads the loaded power. */}
          <svg
            class="cue-power"
            ref={powerEl}
            viewBox="0 0 40 200"
            preserveAspectRatio="xMidYMin meet"
            onPointerDown={onPowerDown}
            onPointerMove={onPowerMove}
            onPointerUp={onPowerUp}
            onPointerCancel={onPowerUp}
          >
            {/* Hide power bar + cue while it isn't this player's turn. */}
            <Show when={myTurn()}>
              {/* Drag target = just the widget column (the viewBox). The cue
                  <image> below is 250 units wide and overflows the box (so it can
                  reach the screen edge), so it's pointer-events:none — otherwise
                  its transparent margins would grab taps a quarter-screen away. */}
              <rect x={0} y={0} width={40} height={200} fill="transparent" pointer-events="all" />
              {/* Power gauge behind the cue: yellow (low, top) → red (high,
                  bottom). Each block shows once the cue is drawn past its
                  level, so the stack grows with power. */}
              {POWER_SEG_COLORS.map((col, i) => (
                <rect
                  x={17}
                  width={6}
                  y={POWER_SEG_TOP + i * (POWER_SEG_H + POWER_SEG_GAP)}
                  height={POWER_SEG_H}
                  rx={1.5}
                  fill={col}
                  opacity={
                    power() * POWER_SEG_SPAN >=
                    i * (POWER_SEG_H + POWER_SEG_GAP) + POWER_SEG_H
                      ? 1
                      : 0
                  }
                />
              ))}
              <image
                href={cueSprite}
                x={20 - CUE_S / 2}
                y={cueImgY()}
                width={CUE_S}
                height={CUE_S}
                pointer-events="none"
              />
            </Show>
          </svg>
        </div>
      </div>

      {/* Comm dock — a direct child of .game-root (NOT inside .left-col, whose
          z-index:3 stacking context would trap it below the z:9 table canvas and
          let the on-table cue paint over the tray). Here it shares the root
          stacking context with the canvas, so its z:10 sits above the cue. */}
      <Show when={!isSpectator()}>
        <div class="comm-dock" classList={{ "dock-raised": showEmojiPicker() }}>
          {/* Kept mounted (never <Show>-toggled) so the emoji glyphs render once
              and stay cached — remounting made them pop in each open. */}
          <div class="emoji-tray" classList={{ open: comm() }} ref={trayEl}>
            {/* "more" opens the searchable full-emoji picker. */}
            <button
              class="tray-more"
              title="more emojis"
              onClick={() => {
                setEmojiSearch("");
                setShowEmojiPicker(true);
              }}
            >
              ⋯
            </button>
            {quickEmojis().map((ch) => (
              <div
                class="tray-emoji"
                onPointerDown={(e) => onTrayDown(ch, e)}
                onPointerMove={onTrayMove}
                onPointerUp={onTrayUp}
                onPointerCancel={onTrayUp}
              >
                {ch}
              </div>
            ))}
          </div>
          <button
            class="comm"
            classList={{ active: comm() }}
            title="communicate"
            onPointerDown={cueDragTakeover}
            onClick={() => setComm((v) => !v)}
          >
            <svg class="comm-ico comm-emoji" viewBox="0 0 24 24">
              {/* Solid silhouette with the eyes + grin punched out as negative
                  space (mask), so it's a single flat colour. */}
              <mask id="comm-smile">
                <rect width="24" height="24" fill="#fff" />
                <ellipse cx="9" cy="9.4" rx="1.5" ry="2" fill="#000" />
                <ellipse cx="15" cy="9.4" rx="1.5" ry="2" fill="#000" />
                <path d="M6.5 13 H17.5 A5.5 5.5 0 0 1 6.5 13 Z" fill="#000" />
              </mask>
              <circle cx="12" cy="12" r="10" fill="currentColor" mask="url(#comm-smile)" />
            </svg>
            <svg
              class="comm-ico comm-x"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.6"
              stroke-linecap="round"
            >
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        </div>
      </Show>

      <Show when={showMenu()}>
        <div class="menu-backdrop" onClick={() => setShowMenu(false)} />
        <div class="pick-modal menu-modal">
          <div class="pm-title">menu</div>
          <button
            class="pm-done"
            onClick={() => {
              saveReplay();
              setShowMenu(false);
            }}
            disabled={(track(), history.length === 0)}
          >
            save replay
          </button>
          <Show when={canFullscreen}>
            <button
              class="pm-done"
              onClick={() => {
                toggleFullscreen();
                setShowMenu(false);
              }}
            >
              {fullscreen() ? "exit fullscreen" : "go fullscreen"}
            </button>
          </Show>
          <Show
            when={rules().winner !== null}
            fallback={
              <button
                class="pm-done resign"
                onClick={resign}
                disabled={isSpectator()}
              >
                resign
              </button>
            }
          >
            <button class="pm-done" onClick={() => navigate("/")}>
              leave
            </button>
          </Show>
        </div>
      </Show>

      <Show when={showEmojiPicker()}>
        <div
          class="menu-backdrop"
          classList={{ "picker-hidden": pickerDragging() }}
          onClick={() => setShowEmojiPicker(false)}
        />
        <div class="pick-modal emoji-modal" classList={{ "picker-hidden": pickerDragging() }}>
          <div class="emoji-modal-head">
            <span class="pm-title">emojis</span>
            <button class="emoji-close" title="close" onClick={() => setShowEmojiPicker(false)}>
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
          <div class="emoji-hint">drag onto the table, or onto the tray to swap a quick emoji</div>
          <div class="emoji-grid">
            {filteredEmojis().map((em) => (
              <div
                class="pick-emoji"
                title={em.name}
                onPointerDown={(e) => onPickerDown(em.ch, e)}
                onPointerMove={onTrayMove}
                onPointerUp={onPickerUp}
                onPointerCancel={onPickerUp}
              >
                {em.ch}
              </div>
            ))}
          </div>
        </div>
      </Show>
    </div>
  );
};

export default Game;
