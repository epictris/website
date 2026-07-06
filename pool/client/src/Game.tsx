import { createSignal, onCleanup, onMount, Show, type Component } from "solid-js";
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
  let tableCueEl!: HTMLImageElement; // on-table cue overlay (can exceed canvas)
  let oppCueEl!: HTMLImageElement; // opponent's blue cue overlay (their aim)
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
  let mode: "aim" | "place" | null = null;
  let downClient = { x: 0, y: 0 }; // pointer-down screen px (tap/drag test)
  let downWorld: Vec = { x: 0, y: 0 }; // pointer-down world point (aim snap)
  let downFinger = 0; // angle cue→finger at press (fine-aim reference)
  let aimStart = 0; // aimAngle at press (fine-aim reference)
  let movedFar = false; // travelled past TAP_PX this gesture
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
  const [canvasH, setCanvasH] = createSignal(360); // sizes the cue column
  const [debug, setDebug] = createSignal(false); // collision-geometry overlay
  const [fullscreen, setFullscreen] = createSignal(false);
  // Transient turn-recap popup: what the last shot did + whose turn it is now.
  const [announce, setAnnounce] = createSignal<string | null>(null);
  let announceTimer: ReturnType<typeof setTimeout> | undefined;
  const showAnnounce = (text: string) => {
    setAnnounce(text);
    if (announceTimer) clearTimeout(announceTimer);
    announceTimer = setTimeout(() => setAnnounce(null), 4500);
  };
  onCleanup(() => announceTimer && clearTimeout(announceTimer));
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
      myGroup,
      onEight,
      opponent: opp,
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

  // Position an on-table cue image (a DOM overlay so it can extend past the
  // canvas edge). Points opposite the aim, behind the ball, pulled back by power.
  // Shared by the active player's cue and the opponent's mirrored blue cue.
  const positionCue = (
    el: HTMLImageElement,
    angle: number,
    pwr: number,
    elev: number,
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
    const gap = rpx * (1.4 + pwr * 6); // pull back grows the gap
    const tipX = bx + Math.cos(back) * gap;
    const tipY = by + Math.sin(back) * gap;
    const size = rpx * 32; // uniform square — no stretch, keeps aspect
    const fore = 0.5 + 0.5 * Math.cos(elev); // raised cue foreshortens
    // Image tip is at 50% 0 (top-centre); pin it to the tip point, then aim.
    el.style.width = `${size}px`;
    el.style.height = `${size}px`;
    el.style.left = `${tipX}px`;
    el.style.top = `${tipY}px`;
    el.style.transform =
      `translate(-50%, 0) rotate(${back - Math.PI / 2}rad) scale(${fore})`;
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
      elevation(),
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
    positionCue(el, opp.aim.angle, opp.aim.power, opp.aim.elevation);
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

  const onPointerDown = (e: PointerEvent) => {
    if (!canAct() || striking) return;
    const w = toWorld(e);
    const cue = world.balls[0].p;
    downClient = { x: e.clientX, y: e.clientY };
    downWorld = w;
    aimStart = aimAngle;
    downFinger = Math.atan2(w.y - cue.y, w.x - cue.x);
    movedFar = false;
    const onCueBall = Math.hypot(w.x - cue.x, w.y - cue.y) < R * 1.7;
    // Ball-in-hand: a press on the cue ball starts a reposition drag.
    mode = rules().ballInHand && onCueBall ? "place" : "aim";
    canvas.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!canAct() || !mode) return;
    const w = toWorld(e);
    const cue = world.balls[0];
    if (Math.hypot(e.clientX - downClient.x, e.clientY - downClient.y) > TAP_PX)
      movedFar = true;
    if (mode === "place") {
      cue.p = clampCue(w);
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
    if (!mode) return;
    const wasPlace = mode === "place";
    mode = null;
    if (wasPlace) {
      pendingPlace = { ...world.balls[0].p };
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
    let nx = (p.x / p.w) * 2 - 1; // -1..1
    let ny = (p.y / p.h) * 2 - 1;
    const r = Math.hypot(nx, ny); // clamp radially so the dot stays in the circle
    if (r > 1) {
      nx /= r;
      ny /= r;
    }
    setSide(nx);
    setFollow(-ny); // up = follow (+)
    recomputePrediction();
  };

  const spinDot = () => ({
    left: `${50 + side() * 42}%`,
    top: `${50 - follow() * 42}%`,
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
          />
          <img class="table-cue" ref={tableCueEl} src={CUE_IMG} alt="" />
          <img class="table-cue" ref={oppCueEl} src={CUE_IMG_BLUE} alt="" />
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
