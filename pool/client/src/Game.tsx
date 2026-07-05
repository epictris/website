import { createSignal, onCleanup, onMount, Show, type Component } from "solid-js";
import { useParams } from "@solidjs/router";
import {
  applyShot,
  atRest,
  cloneWorld,
  DEFAULT_CONFIG,
  freeze,
  FIXED_DT,
  integrateSpin,
  MAX_ELEVATION,
  PARAMS,
  POCKET_LIST,
  predictPaths,
  R,
  rackWorld,
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
  parseReplay,
  worldFromInitial,
  type ReplayShot,
} from "./replay";

const Game: Component = () => {
  const room = useParams().room ?? "lobby";
  let canvas!: HTMLCanvasElement;
  let ctx!: CanvasRenderingContext2D;
  let tableCueEl!: HTMLImageElement; // on-table cue overlay (can exceed canvas)
  let oppCueEl!: HTMLImageElement; // opponent's blue cue overlay (their aim)
  let layout: Layout;

  // --- High-frequency mutable state (not Solid-reactive) ------------------
  let world: World = rackWorld();
  let initialWorld: World = cloneWorld(world);
  let history: ReplayShot[] = [];
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
  let replayQueue: ReplayShot[] = [];
  let shotConfig: PhysicsConfig = DEFAULT_CONFIG; // config a shot animates under
  let opp: { cursor?: Vec; aim?: Aim } = {};
  // Ball-sinking animations (visual only).
  let sinks: { id: number; from: Vec; pocket: Vec; start: number }[] = [];
  const pottedSeen = new Set<number>();
  let nowMs = 0;
  const SINK_MS = 550;
  const resetSinks = () => {
    sinks = [];
    pottedSeen.clear();
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
  // You land straight on the table (solo practice until an opponent joins); the
  // menu is reachable via the back button. false only shows the lobby/menu.
  const [started, setStarted] = createSignal(true);
  const [showTune, setShowTune] = createSignal(false); // spin + cue-angle modal
  const [canvasH, setCanvasH] = createSignal(360); // sizes the cue column
  const [copied, setCopied] = createSignal(false);
  const [debug, setDebug] = createSignal(false); // collision-geometry overlay
  const [fullscreen, setFullscreen] = createSignal(false);
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
        shotCount: history.length,
        config: config(),
      },
    } as Msg);
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
    ws.onclose = () => setTimeout(connect, 1000);
  };

  const onMsg = (m: Msg) => {
    switch (m.t) {
      case "hello": {
        setMySlot(m.slot);
        setPeerCount(m.peers.length + 1);
        // A late joiner (not the authority) asks for the current state.
        if (m.slot > 0) send({ t: "need-sync" } as Msg);
        recomputePrediction();
        break;
      }
      case "peer-join": {
        setPeerCount((n) => n + 1);
        // Opponent just arrived: the host (slot 0) has been knocking balls
        // around solo, so reset to a fresh rack — slot 0 breaks — before syncing.
        // Only on the 1→2 transition; later spectators must not reset the game.
        if (peerCount() === 2 && mySlot() === 0) doRematch(0, false);
        // Any active player answers a new joiner with the current (fresh) state;
        // the joiner keeps the freshest snapshot (see the shotCount guard).
        if (mySlot() === 0 || mySlot() === 1) applySnapshotToPeer(m.slot);
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
        // Never accept a snapshot that is staler than our own game.
        if (m.snap.shotCount < history.length) break;
        if (m.snap.balls.length) {
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
        runShot(m.shot, m.place, false, m.config ?? config());
        break;
      case "config":
        setConfig(m.config);
        recomputePrediction();
        break;
      case "rematch":
        if (m.config) setConfig(m.config);
        doRematch(m.breaker, false);
        break;
    }
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
    setAnimating(true);
    acc = 0;
    bump(0);
    if (local) send({ t: "shot", shot, place, config: cfg } as Msg);
  };

  const resolveShot = () => {
    freeze(world);
    setAnimating(false);
    const before = rules();
    const outcome = evaluateShot(before, worldBefore, events);
    if (outcome.reRack) {
      world = rackWorld();
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
    pendingPlace = undefined;
    recomputePrediction();
    // Advance the replay queue if we are watching one.
    if (replaying()) queueNextReplayShot();
    bump(0);
  };

  // --- Main render / physics loop -----------------------------------------
  const frame = (t: number) => {
    if (!last) last = t;
    let dt = (t - last) / 1000;
    last = t;
    nowMs = t;
    if (dt > 0.1) dt = 0.1; // clamp after a tab stall

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
    drawScene(ctx, {
      world,
      layout,
      myAim: canAct() ? aim : undefined,
      prediction: canAct() ? prediction : undefined,
      showCue: canAct(),
      ballInHand: canAct() && r.ballInHand,
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
  ) => {
    const cue = world.balls[0];
    const s = layout.scale;
    const rpx = R * s;
    // Cue-ball centre in canvas CSS px (mirrors toPx in render.ts).
    const bx = layout.rotated ? layout.ox + (TABLE.h - cue.p.y) * s : layout.ox + cue.p.x * s;
    const by = layout.rotated ? layout.oy + cue.p.x * s : layout.oy + cue.p.y * s;
    const scr = angle + (layout.rotated ? Math.PI / 2 : 0); // world→screen dir
    const back = scr + Math.PI; // cue lies opposite travel
    const gap = rpx * (1.4 + pwr * 3); // pull back grows the gap
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
    if (!canAct() || animating() || cue.potted) {
      el.style.display = "none";
      return;
    }
    el.style.display = "block";
    positionCue(el, aimAngle, power(), elevation());
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

  const sendPresence = (w: Vec, cue: Vec) => {
    const now = performance.now();
    if (now - lastPresence <= 25) return;
    lastPresence = now;
    send({ t: "cursor", x: w.x, y: w.y } as Msg);
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

  const onPointerDown = (e: PointerEvent) => {
    if (!canAct()) return;
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
    if (!movedFar) aimFromCursor(downWorld, world.balls[0].p);
    recomputePrediction();
  };

  // --- Cue power widget (vertical cue left of the table) ------------------
  // Drag the cue back (down) to load power; release to strike.
  let powerEl!: SVGSVGElement;
  let pulling = false;
  let pullStartY = 0;
  const onPowerDown = (e: PointerEvent) => {
    if (!canAct()) return;
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
    if (power() > 0.06) shoot();
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
  const shoot = () => {
    if (!canAct() || power() <= 0.01) return;
    // On a ball-in-hand turn, lock in wherever the cue currently sits.
    const place =
      rules().ballInHand ? pendingPlace ?? { ...world.balls[0].p } : undefined;
    const shot: Shot = {
      angle: aimAngle,
      power: power(),
      follow: follow(),
      side: side(),
      elevation: elevation(),
    };
    runShot(shot, place, true, config());
    setPower(0); // reset for the next pull-back
  };

  const doRematch = (nextBreaker: 0 | 1, local: boolean) => {
    world = rackWorld();
    initialWorld = cloneWorld(world);
    history = [];
    breaker = nextBreaker;
    setRules(initRules(nextBreaker));
    setReplaying(false);
    pendingPlace = undefined;
    resetSinks();
    if (local) send({ t: "rematch", breaker: nextBreaker, config: config() } as Msg);
    recomputePrediction();
    bump(0);
  };

  // Live-tune a physics coefficient; broadcast so the opponent's table matches.
  const setParam = (key: keyof PhysicsConfig, value: number) => {
    const next = { ...config(), [key]: value };
    setConfig(next);
    send({ t: "config", config: next } as Msg);
    recomputePrediction();
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

  const loadReplay = async (file: File) => {
    const r = parseReplay(await file.text());
    world = worldFromInitial(r.initial);
    initialWorld = cloneWorld(world);
    history = [];
    breaker = r.breaker;
    setConfig(r.config);
    resetSinks();
    setRules(initRules(r.breaker));
    replayQueue = [...r.shots];
    setReplaying(true);
    bump(0);
    queueNextReplayShot();
  };

  const copyLink = () => {
    navigator.clipboard?.writeText(`${location.origin}/${room}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
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
      const SIDE_W = 76 + 40; // cue-col + back button widths
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
    connect();
    raf = requestAnimationFrame(frame);

    onCleanup(() => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("fullscreenchange", onFsChange);
      ws?.close();
    });
  });

  // --- Spin pad -----------------------------------------------------------
  let spinEl!: HTMLDivElement;
  const onSpin = (e: PointerEvent) => {
    const p = localPoint(spinEl, e);
    const nx = (p.x / p.w) * 2 - 1; // -1..1
    const ny = (p.y / p.h) * 2 - 1;
    const clamp = (v: number) => Math.max(-1, Math.min(1, v));
    setSide(clamp(nx));
    setFollow(clamp(-ny)); // up = follow (+)
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

  const statusLine = () => {
    const r = rules();
    if (r.winner !== null)
      return { text: r.message, cls: "win" };
    if (r.message.startsWith("Foul")) return { text: r.message, cls: "foul" };
    return { text: r.message, cls: "" };
  };

  return (
    <div class="game-root" classList={{ rot90: rot90() }}>
      <Show when={started() && solo()}>
        <div class="solo-hint">
          Practising solo — waiting for player 2.{" "}
          <button onClick={copyLink}>
            {copied() ? "link copied!" : "copy invite link"}
          </button>
        </div>
      </Show>

      <div class="play-row">
        <button
          class="back-btn"
          title="back to menu"
          onClick={() => setStarted(false)}
        >
          ‹
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
            <image
              href={CUE_IMG}
              x={20 - CUE_S / 2}
              y={cueImgY()}
              width={CUE_S}
              height={CUE_S}
            />
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

      <Show when={!started()}>
        <div class="main-menu">
          <div class="menu-head">
            <span class="title">
              pool<span class="dim">.tris.sh</span>
            </span>
          </div>

          <div class="status">
            {(() => {
              track(); // subscribe to forced recompute
              const s = statusLine();
              return <span class={s.cls}>{s.text}</span>;
            })()}
          </div>

          <div class="link-row">
            <Show
              when={peerCount() > 1}
              fallback={
                <>
                  Waiting for an opponent —{" "}
                  <button onClick={copyLink}>
                    {copied() ? "link copied!" : "copy invite link"}
                  </button>{" "}
                  and send it to a friend.
                </>
              }
            >
              <span class="badge you">you: player {myPlayer() + 1}</span>{" "}
              {peerCount()} connected
              {isSpectator() && " (spectating)"}
            </Show>
          </div>

          <div class="controls">
            <div class="control">
              <span>power {Math.round(power() * 100)}%</span>
              <div class="power-meter">
                <div class="power-fill" style={{ width: `${power() * 100}%` }} />
              </div>
            </div>

            <div class="control">
              <button onClick={() => doRematch(((breaker ^ 1) as 0 | 1), true)}>
                new game
              </button>
              <Show when={canFullscreen}>
                <button onClick={toggleFullscreen}>
                  {fullscreen() ? "exit fullscreen" : "fullscreen"}
                </button>
              </Show>
              <button onClick={() => setDebug((v) => !v)}>
                {debug() ? "hide" : "show"} collision debug (d)
              </button>
            </div>

            <div class="control">
              <button
                onClick={saveReplay}
                disabled={(track(), history.length === 0)}
              >
                save replay
              </button>
              <label class="badge" style={{ cursor: "pointer" }}>
                load replay
                <input
                  type="file"
                  accept="application/json"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const f = e.currentTarget.files?.[0];
                    if (f) loadReplay(f);
                    e.currentTarget.value = "";
                  }}
                />
              </label>
            </div>
          </div>

          <div class="physics">
            <div class="physics-title">physics — measured snooker values</div>
            <div class="physics-grid">
              {PARAMS.map((p) => (
                <label class="phys-row">
                  <span class="phys-label">{p.label}</span>
                  <input
                    type="range"
                    min={p.min}
                    max={p.max}
                    step={p.step}
                    value={config()[p.key]}
                    onInput={(e) => setParam(p.key, Number(e.currentTarget.value))}
                  />
                  <span class="phys-val">{config()[p.key].toFixed(3)}</span>
                </label>
              ))}
            </div>
          </div>

          <div class="link-row">
            tap the felt to aim, drag on it to fine-tune · pull the cue widget
            back and release to strike · spin ball (top) sets draw/follow +
            english · cue-angle widget sets elevation · drag the white ball on a
            foul (ball-in-hand)
          </div>
        </div>
      </Show>
    </div>
  );
};

export default Game;
