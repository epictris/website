import { createSignal, onCleanup, onMount, Show, type Component } from "solid-js";
import { Portal } from "solid-js/web";
import { useNavigate, useParams } from "@solidjs/router";
import {
  applyShot,
  atRest,
  cloneWorld,
  DEFAULT_CONFIG,
  freeze,
  FIXED_DT,
  integrateSpin,
  MAX_ELEVATION,
  POCKET_LIST,
  predictPaths,
  R,
  rackWorld,
  rackSeed,
  stepFixed,
  TABLE,
  type Ball,
  type PhysicsConfig,
  type Prediction,
  type ShotEvent,
  type Shot,
  type Vec,
  type World,
} from "./physics";
import { drawScene, layoutFor, type Aim, type Layout } from "./render";
import { evaluateShot, groupOf, initRules, type RulesState } from "./rules";
import { wsUrl, type Msg } from "./net";
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
  let canvas!: HTMLCanvasElement;
  let ctx!: CanvasRenderingContext2D;
  let tableCueEl!: HTMLCanvasElement; // on-table cue overlay (can exceed canvas)
  let oppCueEl!: HTMLCanvasElement; // opponent's blue cue overlay (their aim)
  let layout: Layout;

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
  const ELEV_GAIN = MAX_ELEVATION / (R * 10); // cue-axis drag (m) → elevation (rad)
  // Cue-stick hit band: behind the ball, along the aim axis, within this half-width.
  const STICK_NEAR = R * 1.2; // starts just off the ball surface
  const STICK_FAR = R * 34; // ...out to the drawn cue length (image is ~32·R long)
  const STICK_PERP = R * 1.8; // perpendicular reach either side of the stick line
  // Gesture the current canvas drag is performing. "spin"/"elev" are new direct
  // manipulations; "place" is the ball-in-hand reposition (now long-press-gated).
  let mode: "aim" | "place" | "spin" | "elev" | null = null;
  let downClient = { x: 0, y: 0 }; // pointer-down screen px (tap/drag test)
  let downWorld: Vec = { x: 0, y: 0 }; // pointer-down world point (aim snap)
  let downFinger = 0; // angle cue→finger at press (fine-aim reference)
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
  // Live table annotation (pointing finger + dotted paths) drawn by whichever
  // player is *waiting* while the other shoots. Only one side annotates at a time
  // (it's gated on !myTurn), so a single bucket serves both the local drawer's
  // own feedback and the incoming remote annotation. `cur` is the in-progress
  // stroke; strokes linger until `expireAt` (set 5s ahead on release).
  type Stroke = { pts: Vec[]; expireAt: number };
  let annot: { pointer?: Vec; strokes: Stroke[]; cur?: Stroke } = { strokes: [] };
  const DRAW_HOLD_MS = 5000;
  const DRAW_FADE_MS = 200; // stroke fades out over this long after its hold ends
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
  let sinks: { id: number; from: Vec; pocket: Vec; start: number }[] = [];
  const pottedSeen = new Set<number>();
  let nowMs = 0;
  const SINK_MS = 550;
  // Speed (world m/s) a potted ball travels under the table from its pocket to
  // the return mouth at the top-left corner (world origin).
  const UNDER_MPS = 1.1;
  // The left-rail ball-return track: every ball potted this game, in the order it
  // dropped. Each rolls into the track once its pocket-drop (SINK_MS) finishes.
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
    sinks.push({ id: b.id, from: { ...b.p }, pocket: nearestHole(b.p), start });
  };

  // --- UI-facing signals --------------------------------------------------
  const [rules, setRules] = createSignal<RulesState>(initRules(0));
  const [mySlot, setMySlot] = createSignal(-1);
  const [peerCount, setPeerCount] = createSignal(1);
  const [power, setPower] = createSignal(0);
  const [follow, setFollow] = createSignal(0);
  const [side, setSide] = createSignal(0);
  const [elevation, setElevation] = createSignal(0); // radians
  const [config, setConfig] = createSignal<PhysicsConfig>(DEFAULT_CONFIG);
  const [animating, setAnimating] = createSignal(false);
  const [replaying, setReplaying] = createSignal(false);
  const [showMenu, setShowMenu] = createSignal(false); // hamburger menu modal
  const [showTune, setShowTune] = createSignal(false); // spin + cue-angle modal
  const [showSpinHud, setShowSpinHud] = createSignal(false); // floating spin window
  const [spinHudPos, setSpinHudPos] = createSignal({ x: 0, y: 0 }); // canvas-local px
  const [spinAim, setSpinAim] = createSignal(0); // aim the spin pad is oriented to
  const [canvasH, setCanvasH] = createSignal(360); // sizes the cue column
  const [debug, setDebug] = createSignal(false); // collision-geometry overlay
  const [fullscreen, setFullscreen] = createSignal(false);
  // Communication mode: a tap on the comm button enables freehand annotation AND
  // opens the emoji tray; tapping again closes both.
  const [comm, setComm] = createSignal(false);
  const EMOJIS = ["🤏", "🗿", "😂", "😅"];
  let dragEl!: HTMLDivElement; // floating emoji preview that follows a tray drag
  let dragCh = ""; // emoji currently being dragged out of the tray
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

  // --- Networking ---------------------------------------------------------
  const send = (m: Partial<Msg>) => ws?.readyState === 1 && ws.send(JSON.stringify(m));

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
        annot.pointer = undefined; // drop a dangling finger if they left mid-draw
        annot.cur = undefined;
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
        // The waiting opponent is annotating our table.
        const p = m.x !== undefined ? { x: m.x, y: m.y! } : undefined;
        if (m.phase === "start") {
          annot.cur = { pts: p ? [p] : [], expireAt: Infinity };
          annot.strokes.push(annot.cur);
          annot.pointer = p;
        } else if (m.phase === "move") {
          annot.pointer = p;
          if (p && annot.cur) annot.cur.pts.push(p);
        } else {
          if (annot.cur) annot.cur.expireAt = nowMs + DRAW_HOLD_MS;
          annot.cur = undefined;
          annot.pointer = undefined;
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
        // pocket-drop it travels UNDER the table to the top-left return mouth —
        // the farther the pocket, the longer before it rolls out of the top.
        if (b.id !== 0 && !rackBalls.some((r) => r.id === b.id)) {
          const hole = nearestHole(b.p);
          const under = (Math.hypot(hole.x, hole.y) / UNDER_MPS) * 1000;
          rackBalls.push({ id: b.id, rollStart: t + SINK_MS + under });
        }
      }
    }
    sinks = sinks.filter((sk) => t - sk.start < SINK_MS);
    // Drop annotation strokes once their hold + fade-out lifetime elapses.
    annot.strokes = annot.strokes.filter((s) => t < s.expireAt + DRAW_FADE_MS);
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
    // At rest (zero power) show a plain straight aim line to the first contact
    // point: full power so it reaches, and no spin so it doesn't curve. Once the
    // cue is pulled back, preview the real spin-aware path at that power.
    const p = power();
    if (p > 0.01) {
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
    } else {
      // At rest: a plain straight aim line to the first contact point (full
      // power so it reaches, no spin so it doesn't curve).
      const shot: Shot = { angle: aimAngle, power: 1, follow: 0, side: 0, elevation: 0 };
      prediction = predictPaths(world, shot, config());
    }
  };

  const draw = () => {
    const r = rules();
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
    // During the cue-forward strike the DOM cue animates on its own; suppress the
    // canvas aim line + guide so only the moving cue shows.
    const live = canAct() && !striking;
    drawScene(ctx, {
      world,
      layout,
      myAim: live ? aim : undefined,
      prediction: live ? prediction : undefined,
      showCue: live,
      ballInHand: live && r.ballInHand,
      growCue: placeMode, // enlarge the cue ball while it's grabbed for placement
      myGroup,
      onEight,
      opponent: opp,
      pointer: annot.pointer,
      // Full opacity through the hold, then a linear fade over DRAW_FADE_MS.
      strokes: annot.strokes.map((s) => ({
        pts: s.pts,
        alpha:
          nowMs < s.expireAt
            ? 1
            : Math.max(0, 1 - (nowMs - s.expireAt) / DRAW_FADE_MS),
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
        t: Math.min(1, (nowMs - sk.start) / SINK_MS),
      })),
      rack: rackBalls,
      now: nowMs,
    });
    updateTableCue();
    updateOppCue();
  };

  // Cue colours matching the cue art: a wood shaft, a coloured wrap (red = you,
  // blue = opponent), then a black butt. Drawn procedurally — see drawCueRod.
  type CueBand = { dark: string; light: string };
  const CUE_RED: CueBand = { dark: "#7a0f22", light: "#a1142c" };
  const CUE_BLUE: CueBand = { dark: "#1d3f74", light: "#356ac0" };

  // Draw the cue into its canvas as a shaded, tapered rod pointing straight down
  // from the tip (image top-centre); the caller then aims it with a plain 2D
  // rotate. Roundness comes from a real cross-width light gradient (bright stripe
  // off-centre, dark edges), not a warped photo — so it reads as a cylinder at
  // any aim. Elevation (tf) foreshortens the length and fattens the butt, faking
  // the cue rearing up without any 3D transform to flatten out.
  const CUE_CURVE = 1.0; // how hard the colour rings bow toward the tip when reared
  const CUE_PULL_TILT = 0.4; // rad of butt-toward-camera lift at full pull on a vertical cue
  const CUE_PULL_ZOOM = 0.3; // extra scale at full pull on a vertical cue (nearer camera)
  const drawCueRod = (canvas: HTMLCanvasElement, sizeCss: number, elev: number, band: CueBand) => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const px = Math.max(1, Math.round(sizeCss * dpr));
    canvas.width = px;
    canvas.height = px;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    const S = sizeCss;
    const cx = S / 2;
    const tipR = S * 0.0072; // ferrule half-width (thin end)
    const buttR = S * 0.0168 * (1 + 0.9 * (1 - Math.cos(elev))); // fattens by cos when reared
    const len = S * 0.9358 * Math.cos(elev); // rears up → foreshortened by cos (physical)

    // Rod silhouette: rounded nose at the top (its cap crown sits at y=0, the
    // pinned tip point) tapering out to a rounded butt.
    ctx.beginPath();
    ctx.moveTo(cx - tipR, tipR);
    ctx.lineTo(cx - buttR, len);
    ctx.arc(cx, len, buttR, Math.PI, 0, true); // butt cap (convex, bulging outward)
    ctx.lineTo(cx + tipR, tipR);
    ctx.arc(cx, tipR, tipR, 0, Math.PI, true); // nose cap (crown at y=0)
    ctx.closePath();
    ctx.save();
    ctx.clip();

    // Solid length sections with hard boundaries (no gradients), but each
    // boundary is a RING that bows toward the tip as the cue rears up — a flat
    // band on a cylinder reads as a curved arc when foreshortened. Bow depth =
    // local radius × sin(elev), so it's a straight line at a flat cue and a full
    // arc when steep. Painted top→bottom: each colour fills from its curved
    // boundary down to the butt, so the one below overwrites, leaving clean
    // curved bands with no gaps or overlap.
    const sinE = Math.sin(elev);
    const localR = (y: number) =>
      tipR + (buttR - tipR) * Math.max(0, Math.min(1, y / len));
    const fillFromRing = (yBase: number, color: string) => {
      const r = localR(yBase);
      const amp = r * sinE * CUE_CURVE;
      ctx.beginPath();
      const N = 26;
      for (let i = 0; i <= N; i++) {
        const x = -buttR + 2 * buttR * (i / N);
        const u = r > 0 ? x / r : 2;
        const dip = Math.abs(u) < 1 ? amp * Math.sqrt(1 - u * u) : 0; // arc, flat past the rim
        const pt = { x: cx + x, y: yBase - dip };
        i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y);
      }
      ctx.lineTo(cx + buttR, len + buttR);
      ctx.lineTo(cx - buttR, len + buttR);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    };
    fillFromRing(0, "#93685b"); // cue tip
    fillFromRing(len * 0.0106, "#f4efda"); // white part of the tip
    fillFromRing(len * 0.0481, "#e3c3a6"); // wood stem
    fillFromRing(len * 0.6107, "#1d1d1b"); // black grip
    fillFromRing(len * 0.642, band.light); // handle (red you / blue opponent)
    fillFromRing(len * 0.9363, "#1d1d1b"); // black butt

    // Roundness via cel-shade stripes: solid, flat-alpha vertical bands across the
    // width (dark rims, one bright stripe off-centre) — clean edges, not gradients.
    const stripes: [number, number, string][] = [
      [0.0, 0.16, "rgba(0,0,0,0.42)"],
      [0.16, 0.34, "rgba(0,0,0,0.18)"],
      [0.74, 0.86, "rgba(0,0,0,0.2)"],
      [0.86, 1.0, "rgba(0,0,0,0.44)"],
    ];
    for (const [a, b, color] of stripes) {
      ctx.fillStyle = color;
      ctx.fillRect(cx - buttR + a * buttR * 2, 0, (b - a) * buttR * 2, len + buttR);
    }

    ctx.restore();
  };

  // Position an on-table cue (a DOM overlay so it can extend past the canvas
  // edge). Points opposite the aim, behind the ball, pulled back by power.
  // Shared by the active player's cue and the opponent's mirrored blue cue.
  const positionCue = (
    el: HTMLCanvasElement,
    angle: number,
    pwr: number,
    elev: number,
    band: CueBand, // which cue colour to draw
    atPos?: Vec, // pin to a frozen cue-ball point (strike linger) instead of live
  ) => {
    const p = atPos ?? world.balls[0].p;
    const s = layout.scale;
    const rpx = R * s;
    // Cue-ball centre in canvas CSS px (mirrors toPx in render.ts).
    const bx = layout.rotated ? layout.ox + (TABLE.h - p.y) * s : layout.ox + p.x * s;
    const by = layout.rotated ? layout.oy + p.x * s : layout.oy + p.y * s;
    const scr = angle + (layout.rotated ? Math.PI / 2 : 0); // world→screen dir
    const back = scr + Math.PI; // cue lies opposite travel
    const tf = elev / MAX_ELEVATION; // 0..1 how far the cue is reared up
    // Resting tip position: a reared cue slides slightly toward the ball so its
    // foreshortened butt hangs over the cue ball. Power pulls it back along aim.
    const gap = rpx * 1.4 - rpx * 1 * tf;
    const tipX = bx + Math.cos(back) * gap;
    const tipY = by + Math.sin(back) * gap;
    const size = rpx * 32; // square canvas; the rod is drawn inside it
    // Pull-back rides the elevated cue axis: the along-table slide shrinks with
    // cos(elev), and a pull-driven 3D tilt (about the pinned tip, under perspective)
    // lifts the butt UP OUT OF THE TABLE toward the camera — not up the screen. The
    // static elevation look is already baked into the drawing; this only adds the
    // lift while the cue is drawn back (and drives back down on the strike poke).
    const pull = pwr * 6 * rpx;
    const slide = pull * Math.cos(elev); // along the aim line
    const tilt = pwr * Math.sin(elev) * CUE_PULL_TILT; // butt toward camera
    const zoom = 1 + pwr * Math.sin(elev) * CUE_PULL_ZOOM; // nearer the camera → bigger
    const persp = size * 2.5;
    // Tip (rod nose, canvas 50% 0) pinned to the tip point; a plain 2D rotate aims it.
    el.style.width = `${size}px`;
    el.style.height = `${size}px`;
    el.style.left = `${tipX}px`;
    el.style.top = `${tipY}px`;
    el.style.transform =
      `translate(-50%, 0) scale(${zoom}) rotate(${back - Math.PI / 2}rad) ` +
      `perspective(${persp}px) rotateX(${tilt}rad) translateY(${slide}px)`;
    drawCueRod(el, size, elev, band);
  };

  const updateTableCue = () => {
    const el = tableCueEl;
    if (!el) return;
    const cue = world.balls[0];
    // During the strike swing and the post-strike linger the cue stays visible
    // (frozen at the contact point) even while the shot animates.
    const active = striking || lingering;
    const show = active || (canAct() && !animating() && !cue.potted);
    if (!show) {
      el.style.display = "none";
      return;
    }
    el.style.display = "block";
    positionCue(
      el,
      aimAngle,
      active ? strikePwr : power(),
      active ? strikeElev : elevation(), // swing/linger replay at the shot's angle
      CUE_RED,
      active ? strikeCuePos : undefined,
    );
  };

  // The opponent's cue — a blue image mirroring their live aim, in the same
  // position the active player's cue would be. Shown only during their turn.
  // (Their raw cursor is intentionally hidden; only this cue is visible.)
  const updateOppCue = () => {
    const el = oppCueEl;
    if (!el) return;
    const cue = world.balls[0];
    if (canAct() || animating() || cue.potted || !opp.aim) {
      el.style.display = "none";
      return;
    }
    el.style.display = "block";
    positionCue(el, opp.aim.angle, opp.aim.power, opp.aim.elevation, CUE_BLUE);
  };

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
    let x = Math.max(R, Math.min(TABLE.w - R, p.x));
    let y = Math.max(R, Math.min(TABLE.h - R, p.y));
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
    if (now - lastPresence <= 25) return;
    lastPresence = now;
    send({ t: "cursor", x: w.x, y: w.y } as Msg);
    sendAim(cue);
  };

  // --- Table annotation (comm mode) ---------------------------------------
  // With comm mode on, our canvas pointer draws instead of aiming: touch shows a
  // pointing finger on the other table, drag leaves a dotted path. `draw` msgs.
  const startDraw = (e: PointerEvent) => {
    const w = toWorld(e);
    drawing = true;
    annot.cur = { pts: [w], expireAt: Infinity };
    annot.strokes.push(annot.cur);
    annot.pointer = w;
    lastDraw = 0;
    canvas.setPointerCapture(e.pointerId);
    send({ t: "draw", phase: "start", x: w.x, y: w.y } as Msg);
  };
  const moveDraw = (e: PointerEvent) => {
    const w = toWorld(e);
    annot.pointer = w;
    if (annot.cur) annot.cur.pts.push(w); // append locally every move (smooth line)
    const now = performance.now();
    if (now - lastDraw <= 30) return; // throttle only the network stream
    lastDraw = now;
    send({ t: "draw", phase: "move", x: w.x, y: w.y } as Msg);
  };
  const endDraw = () => {
    if (!drawing) return;
    drawing = false;
    if (annot.cur) annot.cur.expireAt = nowMs + DRAW_HOLD_MS;
    annot.cur = undefined;
    annot.pointer = undefined;
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
    // Dropped over the felt? Spawn the stamp at that world point (clamped so it
    // sits fully on the table even near an edge).
    const r = canvas.getBoundingClientRect();
    if (
      e.clientX >= r.left && e.clientX <= r.right &&
      e.clientY >= r.top && e.clientY <= r.bottom
    ) {
      const w = toWorld(e);
      spawnStamp(ch, {
        x: Math.max(0, Math.min(TABLE.w, w.x)),
        y: Math.max(0, Math.min(TABLE.h, w.y)),
      });
    }
  };

  // Classify a canvas press into one of four gestures by *where* it lands:
  //  - on the cue ball  → spin (swipe away opens the floating window); during
  //    ball-in-hand a 1s hold-without-swipe instead grabs the ball to reposition.
  //  - on the cue stick → cue elevation (drag along the axis, toward/away).
  //  - anywhere else     → aim (tap snaps, drag fine-tunes) — unchanged.
  const onPointerDown = (e: PointerEvent) => {
    if (canPoint()) return startDraw(e); // waiting: annotate instead of aim
    if (!canAct() || striking) return;
    const w = toWorld(e);
    const cue = world.balls[0].p;
    downClient = { x: e.clientX, y: e.clientY };
    downWorld = w;
    aimStart = aimAngle;
    downFinger = Math.atan2(w.y - cue.y, w.x - cue.x);
    movedFar = false;
    const onCueBall = Math.hypot(w.x - cue.x, w.y - cue.y) < R * 1.7;
    // Project the press onto the cue axis (the stick lies opposite the aim).
    const back = aimAngle + Math.PI;
    const proj = (w.x - cue.x) * Math.cos(back) + (w.y - cue.y) * Math.sin(back);
    const perp = -(w.x - cue.x) * Math.sin(back) + (w.y - cue.y) * Math.cos(back);
    const onCueStick =
      !onCueBall &&
      proj > STICK_NEAR && proj < STICK_FAR && Math.abs(perp) < STICK_PERP;

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
    canvas.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent) => {
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
      // Drag along the cue axis: toward the ball (proj shrinks) raises the cue.
      const back = aimStart + Math.PI;
      const proj = (w.x - cue.p.x) * Math.cos(back) + (w.y - cue.p.y) * Math.sin(back);
      const el = elevStart - (proj - projStart) * ELEV_GAIN;
      setElevation(Math.max(0, Math.min(MAX_ELEVATION, el)));
    } else if (movedFar) {
      // Fine aim: rotate the shot about the cue ball by a fraction of the
      // finger's swing (slower than the finger, for precision).
      const finger = Math.atan2(w.y - cue.p.y, w.x - cue.p.x);
      if (Math.hypot(w.x - cue.p.x, w.y - cue.p.y) > R)
        aimAngle = aimStart + wrapPi(finger - downFinger) * AIM_GAIN;
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
    if (!canAct() || striking) return;
    powerEl.setPointerCapture(e.pointerId);
    pulling = true;
    pullStartY = localPoint(powerEl, e).y; // widget-local, survives 90° rotation
    setPower(0);
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
    if (power() > 0) shoot();
    else {
      setPower(0);
      recomputePrediction();
    }
  };
  // Cue image (tip at very top, butt at bottom), square with transparent margins.
  const CUE_IMG = "https://iili.io/CaZTlqP.png"; // active player's own (red) cue
  const CUE_IMG_BLUE = "https://iili.io/CatLF5v.png"; // opponent's (blue) cue
  const CUE_S = 250; // square draw size in the 40×200 viewBox (bigger = thicker)
  const CUE_TIP_FRAC = 0; // tip sits at the top edge of the source image
  // Tip sits just under the spin ball (top) and slides down as power loads.
  const powerTipY = () => 8 + power() * 110;
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

  // Swing done: fire the physics, but keep the cue drawn at the contact point
  // for STRIKE_LINGER_MS so it doesn't blink out the instant the ball leaves.
  const finishStrike = () => {
    striking = false;
    if (strikeShot) runShot(strikeShot, strikePlace, true, config());
    strikeShot = undefined;
    setPower(0); // reset for the next pull-back
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
      // the side widgets. The canvas size scales linearly with `scale`, so
      // measure it at scale 1 and divide the available space by that.
      const SIDE_W = 76 + 30; // cue-col + hamburger button widths
      // Leave slack for 4 even gaps (space-evenly: outside both ends + between
      // each of the 3 items) so the row breathes uniformly.
      const GAPS = 14 * 4;
      const unit = layoutFor(1, false); // always landscape
      const availW = vw - SIDE_W - GAPS;
      const availH = vh;
      let scale = Math.min(availW / unit.W, availH / unit.H);
      scale = Math.max(40, Math.min(scale, 430));
      layout = layoutFor(scale, false);
      const dpr = window.devicePixelRatio || 1;
      canvas.width = layout.W * dpr;
      canvas.height = layout.H * dpr;
      canvas.style.width = `${layout.W}px`;
      canvas.style.height = `${layout.H}px`;
      setCanvasH(layout.H);
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

  // --- Spin pad -----------------------------------------------------------
  let spinEl!: HTMLDivElement;
  const onSpin = (e: PointerEvent) => {
    const p = localPoint(spinEl, e);
    // Pointer as a fraction of the ball radius (pad edge = the ball's edge).
    const nx = (p.x / p.w) * 2 - 1;
    const ny = (p.y / p.h) * 2 - 1;
    // side/follow are normalised so ±1 == the miscue limit (half the ball
    // radius — see applyShot's 1.25 coefficient). A ball-fraction of 0.5 is a
    // full slider, so scale up, then clamp to the unit (miscue) circle: past the
    // miscue ring the dot pins to it, it can never be placed outside.
    let sx = nx * 2;
    let sy = ny * 2;
    const r = Math.hypot(sx, sy);
    if (r > 1) {
      sx /= r;
      sy /= r;
    }
    setSide(sx);
    setFollow(-sy); // up = follow (+)
    recomputePrediction();
  };

  // Dot offset: ±1 slider sits at half the ball radius (the miscue ring). The
  // pad's drawn radius is 50% of its box, so a full slider is 25% off centre.
  const spinDot = () => ({
    left: `${50 + side() * 25}%`,
    top: `${50 - follow() * 25}%`,
  });

  // --- Cue elevation widget (square side view; drag the cue to set angle) ---
  let cueEl!: SVGSVGElement;
  const EBALL = { x: 60, y: 62 }; // ball centre in the 100×100 viewBox
  const EBALL_R = 12;
  const TIP_GAP = 5; // cue tip stops this far short of the ball surface
  const ECUE_LEN = 40;
  const onCueDrag = (e: PointerEvent) => {
    const p = localPoint(cueEl, e);
    const lx = (p.x / p.w) * 100;
    const ly = (p.y / p.h) * 100;
    const ang = Math.atan2(EBALL.y - ly, EBALL.x - lx);
    setElevation(Math.max(0, Math.min(MAX_ELEVATION, ang)));
    recomputePrediction();
  };
  // Cue lies up-left of the ball; tip sits TIP_GAP off the surface, butt beyond.
  const cueGeom = () => {
    const ux = -Math.cos(elevation());
    const uy = -Math.sin(elevation());
    const dTip = EBALL_R + TIP_GAP;
    return {
      tip: { x: EBALL.x + dTip * ux, y: EBALL.y + dTip * uy },
      butt: { x: EBALL.x + (dTip + ECUE_LEN) * ux, y: EBALL.y + (dTip + ECUE_LEN) * uy },
    };
  };

  // Drag hint: an arc around the ball spanning the cue's swept elevation range,
  // arrowhead at each end — you rotate the cue by dragging along it.
  const ARC_R = 27;
  const arcPt = (e: number) => ({
    x: EBALL.x - ARC_R * Math.cos(e),
    y: EBALL.y - ARC_R * Math.sin(e),
  });
  // Small triangle whose apex is `at`, pointing along `dir` (radians).
  const arcArrow = (at: { x: number; y: number }, dir: number) => {
    const dx = Math.cos(dir), dy = Math.sin(dir);
    const bx = at.x - 5 * dx, by = at.y - 5 * dy; // base, 5u back along -dir
    const px = -dy * 3, py = dx * 3; // half-width perpendicular
    return `${at.x},${at.y} ${bx + px},${by + py} ${bx - px},${by - py}`;
  };
  const cueArc = () => {
    const a = arcPt(0);
    const b = arcPt(MAX_ELEVATION);
    return {
      d: `M ${a.x} ${a.y} A ${ARC_R} ${ARC_R} 0 0 1 ${b.x} ${b.y}`,
      // outward tangents: decreasing-elev at the low end, increasing at the high end
      loArrow: arcArrow(a, Math.PI / 2),
      hiArrow: arcArrow(b, Math.atan2(-Math.cos(MAX_ELEVATION), Math.sin(MAX_ELEVATION))),
    };
  };

  return (
    <div class="game-root" classList={{ rot90: rot90() }}>
      <Show when={announce()}>
        <div class="turn-recap">{announce()}</div>
      </Show>

      {/* Comm dock, bottom-left below the menu: toggles draw mode + emoji tray. */}
      <Show when={!isSpectator()}>
        <div class="comm-dock">
          {/* Kept mounted (never <Show>-toggled) so the emoji glyphs render once
              and stay cached — remounting made them pop in / reflow each open. */}
          <div class="emoji-tray" classList={{ open: comm() }}>
            {EMOJIS.map((ch) => (
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
            onClick={() => setComm((v) => !v)}
          >
            💬
          </button>
        </div>
      </Show>
      {/* Floating emoji preview that follows the finger during a tray drag.
          Portaled to <body> so it stays in true screen space — inside the
          rot90-transformed game root, a position:fixed child would be offset. */}
      <Portal>
        <div class="emoji-drag" ref={dragEl} />
      </Portal>

      <div class="play-row">
        <button
          class="hamburger"
          title="menu"
          onClick={() => setShowMenu(true)}
        >
          ☰
        </button>

        <div class="table-wrap">
          <canvas
            ref={canvas}
            onPointerMove={onPointerMove}
            onPointerDown={onPointerDown}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onContextMenu={(e) => e.preventDefault()}
          />
          <canvas class="table-cue" ref={tableCueEl} />
          <canvas class="table-cue" ref={oppCueEl} />
          {/* Floating spin window — pops up at the finger while dragging off the
              cue ball, gone on release. A child of .table-wrap so it rides the
              rot90 transform and shares the canvas-local frame the drag maps in. */}
          <Show when={showSpinHud()}>
            <div
              class="spin-hud"
              style={{
                left: `${spinHudPos().x}px`,
                top: `${spinHudPos().y}px`,
                // Spin up (−y) aligns with the cue's aim direction on screen.
                transform: `translate(-50%, -50%) rotate(${spinAim() + Math.PI / 2}rad)`,
              }}
            >
              <div class="spin">
                <div class="axis h" />
                <div class="axis v" />
                <div class="miscue" />
                <div class="dot" style={spinDot()} />
              </div>
            </div>
          </Show>
        </div>

        <div class="cue-col" style={{ height: `${canvasH()}px` }}>
          {/* White-ball button — opens the spin + cue-angle modal. Its dot
              previews the current english. */}
          <button
            class="tune-ball spin"
            title="spin & cue angle"
            onClick={() => setShowTune(true)}
          >
            <div class="axis h" />
            <div class="axis v" />
            <div class="dot" style={spinDot()} />
          </button>

          {/* Cue power — fills the remaining height; pull back to strike. */}
          <svg
            class="cue-power"
            ref={powerEl}
            viewBox="0 0 40 200"
            preserveAspectRatio="xMidYMid meet"
            onPointerDown={onPowerDown}
            onPointerMove={onPowerMove}
            onPointerUp={onPowerUp}
            onPointerCancel={onPowerUp}
          >
            {/* Hide the pull-back cue while it isn't this player's turn. */}
            <Show when={myTurn()}>
              <image
                href={CUE_IMG}
                x={20 - CUE_S / 2}
                y={cueImgY()}
                width={CUE_S}
                height={CUE_S}
              />
            </Show>
          </svg>
        </div>
      </div>

      <Show when={showTune()}>
        <div class="menu-backdrop" onClick={() => setShowTune(false)} />
        <div class="pick-modal">
          <div class="tune-grid">
            <div class="tune-cell">
              <div
                class="spin"
                ref={spinEl}
                onPointerDown={(e) => {
                  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                  onSpin(e);
                }}
                onPointerMove={(e) => e.buttons && onSpin(e)}
              >
                <div class="axis h" />
                <div class="axis v" />
                <div class="miscue" />
                <div class="dot" style={spinDot()} />
              </div>
            </div>

            <div class="tune-cell">
              <svg
                class="cue-elev"
                ref={cueEl}
                viewBox="0 0 100 100"
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  onCueDrag(e);
                }}
                onPointerMove={(e) => e.buttons && onCueDrag(e)}
              >
                <line class="surface" x1="8" y1="74" x2="92" y2="74" />
                <ellipse class="shadow" cx="60" cy="74" rx="13" ry="3" />
                <circle class="ball" cx="60" cy="62" r="12" />
                <path class="arc" d={cueArc().d} />
                <polygon class="arc-head" points={cueArc().loArrow} />
                <polygon class="arc-head" points={cueArc().hiArrow} />
                <line
                  class="cue"
                  x1={cueGeom().butt.x}
                  y1={cueGeom().butt.y}
                  x2={cueGeom().tip.x}
                  y2={cueGeom().tip.y}
                />
                <circle class="tip" cx={cueGeom().tip.x} cy={cueGeom().tip.y} r="2.8" />
              </svg>
            </div>
          </div>
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
    </div>
  );
};

export default Game;
