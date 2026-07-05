import { createSignal, onCleanup, onMount, Show, type Component } from "solid-js";
import { useParams } from "@solidjs/router";
import {
  applyShot,
  atRest,
  cloneWorld,
  DEFAULT_CONFIG,
  freeze,
  FIXED_DT,
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
import { evaluateShot, initRules, type RulesState } from "./rules";
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
  let layout: Layout;

  // --- High-frequency mutable state (not Solid-reactive) ------------------
  let world: World = rackWorld();
  let initialWorld: World = cloneWorld(world);
  let history: ReplayShot[] = [];
  let events: ShotEvent[] = [];
  let acc = 0; // physics time accumulator
  let last = 0;
  let pendingPlace: Vec | undefined;
  let draggingCue = false;
  let charging = false; // dragging on the table to build power
  let pressDist = 0; // cursor's distance from the cue ball when the pull started
  const MAX_PULL = 0.5; // extra outward drag distance for full power
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
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [copied, setCopied] = createSignal(false);
  const [debug, setDebug] = createSignal(false); // collision-geometry overlay
  const [fullscreen, setFullscreen] = createSignal(false);
  // Fullscreen API is absent on iPhone Safari (iPad/Android/desktop are fine).
  const canFullscreen =
    typeof document !== "undefined" &&
    !!document.documentElement.requestFullscreen;
  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  };
  // On-load nudge: on a touch device that isn't fullscreen yet, offer to go
  // immersive + lock rotation. Orientation lock only works while fullscreen,
  // so both must fire from the one tap.
  const [showFsPrompt, setShowFsPrompt] = createSignal(false);
  const isMobile =
    typeof matchMedia !== "undefined" &&
    matchMedia("(pointer: coarse)").matches &&
    window.innerWidth < 900;
  // iOS has no Fullscreen API — the only route to a chromeless app is
  // Add-to-Home-Screen. Can't trigger the Share sheet, so we show a hint.
  const [showA2HS, setShowA2HS] = createSignal(false);
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const isIOS =
    /iP(hone|od|ad)/.test(ua) ||
    // iPadOS 13+ masquerades as a Mac.
    (navigator?.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  // In-app webviews (Instagram, etc.) can't A2HS; only real Safari can.
  const isIOSSafari =
    isIOS && /Safari/.test(ua) && !/(CriOS|FxiOS|EdgiOS|GSA|Instagram|FBAN|FBAV)/.test(ua);
  const isStandalone =
    (navigator as any)?.standalone === true ||
    (typeof matchMedia !== "undefined" &&
      matchMedia("(display-mode: standalone)").matches);
  const enterImmersive = async () => {
    setShowFsPrompt(false);
    try {
      await document.documentElement.requestFullscreen();
      await (screen.orientation as any)?.lock?.("landscape");
    } catch {
      // Fullscreen refused or orientation lock unsupported — ignore.
    }
  };
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
        // Any active player answers a new joiner; the joiner keeps the
        // freshest snapshot (see the shotCount guard in "sync").
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
    if (!canAct() || cue.potted || power() <= 0.01) {
      prediction = undefined;
      return;
    }
    prediction = predictPaths(world, {
      angle: aimAngle,
      power: power(),
      follow: follow(),
      side: side(),
      elevation: elevation(),
    }, config());
  };

  const draw = () => {
    const r = rules();
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
      myGroup: r.groups[myPlayer()],
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
  };

  // --- Pointer input ------------------------------------------------------
  const toWorld = (e: PointerEvent): Vec => {
    const rect = canvas.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * layout.W;
    const py = ((e.clientY - rect.top) / rect.height) * layout.H;
    if (layout.rotated) {
      // Inverse of the portrait 90° rotation (see toPx in render.ts).
      return {
        x: (py - layout.oy) / layout.scale,
        y: TABLE.h - (px - layout.ox) / layout.scale,
      };
    }
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

  // The cue aims AT the cursor: the ball fires toward it (jitter-guarded).
  const aimFromCursor = (cursor: Vec, cue: Vec) => {
    const dx = cursor.x - cue.x;
    const dy = cursor.y - cue.y;
    if (Math.hypot(dx, dy) > R * 1.2) aimAngle = Math.atan2(dy, dx);
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

  const onPointerMove = (e: PointerEvent) => {
    if (!canAct()) return;
    const w = toWorld(e);
    const cue = world.balls[0];
    if (draggingCue) {
      cue.p = clampCue(w);
    } else {
      // Aim tracks the cursor the whole time; while charging, power grows as
      // the cursor is dragged away from the cue ball past the press radius —
      // dragging back toward the cue ball counts as zero.
      aimFromCursor(w, cue.p);
      if (charging) {
        const d = Math.hypot(w.x - cue.p.x, w.y - cue.p.y);
        setPower(Math.max(0, Math.min(1, (d - pressDist) / MAX_PULL)));
      }
    }
    recomputePrediction();
    sendPresence(w, cue.p);
  };

  const onPointerDown = (e: PointerEvent) => {
    if (!canAct()) return;
    const w = toWorld(e);
    const cue = world.balls[0];
    if (rules().ballInHand && Math.hypot(w.x - cue.p.x, w.y - cue.p.y) < R * 2.5) {
      draggingCue = true;
      canvas.setPointerCapture(e.pointerId);
      return;
    }
    // Start charging: power is measured outward from the cue ball, starting at
    // wherever the cursor currently is (so it begins at zero).
    aimFromCursor(w, cue.p);
    charging = true;
    pressDist = Math.hypot(w.x - cue.p.x, w.y - cue.p.y);
    setPower(0);
    canvas.setPointerCapture(e.pointerId);
    recomputePrediction();
  };

  const onPointerUp = () => {
    if (draggingCue) {
      draggingCue = false;
      pendingPlace = { ...world.balls[0].p };
      recomputePrediction();
      return;
    }
    if (charging) {
      charging = false;
      if (power() > 0.05) shoot();
      else {
        setPower(0);
        recomputePrediction();
      }
    }
  };

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
      const portrait =
        window.innerHeight > window.innerWidth && window.innerWidth < 700;
      // Fit the whole table PHOTO (felt + wooden rails) into the viewport minus
      // edge padding and the widget row. The canvas size scales linearly with
      // `scale`, so measure it at scale 1 and divide the available space by that.
      const PAD = 12;
      const WIDGETS = 132; // spin / cue-angle / menu row + gaps
      const unit = layoutFor(1, portrait);
      const availW = window.innerWidth - PAD * 2;
      const availH = window.innerHeight - PAD * 2 - WIDGETS;
      let scale = Math.min(availW / unit.W, availH / unit.H);
      scale = Math.max(40, Math.min(scale, 430));
      layout = layoutFor(scale, portrait);
      const dpr = window.devicePixelRatio || 1;
      canvas.width = layout.W * dpr;
      canvas.height = layout.H * dpr;
      canvas.style.width = `${layout.W}px`;
      canvas.style.height = `${layout.H}px`;
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
      const fs = !!document.fullscreenElement;
      setFullscreen(fs);
      if (fs) setShowFsPrompt(false);
      resize(); // viewport dimensions change entering/leaving fullscreen
    };
    document.addEventListener("fullscreenchange", onFsChange);
    if (isIOSSafari && !isStandalone) setShowA2HS(true);
    else if (canFullscreen && isMobile && !document.fullscreenElement)
      setShowFsPrompt(true);
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
    const rect = spinEl.getBoundingClientRect();
    const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1; // -1..1
    const ny = ((e.clientY - rect.top) / rect.height) * 2 - 1;
    const clamp = (v: number) => Math.max(-1, Math.min(1, v));
    setSide(clamp(nx));
    setFollow(clamp(-ny)); // up = follow (+)
    recomputePrediction();
  };

  const spinDot = () => ({
    left: `${50 + side() * 42}%`,
    top: `${50 - follow() * 42}%`,
  });

  // --- Cue elevation widget (side view; drag the cue to set the angle) -----
  let cueEl!: SVGSVGElement;
  const PIVOT = { x: 68, y: 50 }; // where the cue tip meets the ball (viewBox)
  const CUE_LEN = 44;
  const onCueDrag = (e: PointerEvent) => {
    const rect = cueEl.getBoundingClientRect();
    const lx = ((e.clientX - rect.left) / rect.width) * 100;
    const ly = ((e.clientY - rect.top) / rect.height) * 80;
    const ang = Math.atan2(PIVOT.y - ly, PIVOT.x - lx);
    setElevation(Math.max(0, Math.min(MAX_ELEVATION, ang)));
    recomputePrediction();
  };
  const cueEnd = () => ({
    x: PIVOT.x - CUE_LEN * Math.cos(elevation()),
    y: PIVOT.y - CUE_LEN * Math.sin(elevation()),
  });

  const statusLine = () => {
    const r = rules();
    if (r.winner !== null)
      return { text: r.message, cls: "win" };
    if (r.message.startsWith("Foul")) return { text: r.message, cls: "foul" };
    return { text: r.message, cls: "" };
  };

  return (
    <>
      <div class="table-wrap">
        <canvas
          ref={canvas}
          onPointerMove={onPointerMove}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
        />
      </div>

      <div class="aim-controls">
        <div class="control">
          <span>spin</span>
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

        <div class="control">
          <span>cue angle {Math.round((elevation() * 180) / Math.PI)}°</span>
          <svg
            class="cue-elev"
            ref={cueEl}
            viewBox="0 0 100 80"
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              onCueDrag(e);
            }}
            onPointerMove={(e) => e.buttons && onCueDrag(e)}
          >
            <line class="surface" x1="6" y1="60" x2="94" y2="60" />
            <ellipse class="shadow" cx="70" cy="60" rx="9" ry="2" />
            <circle class="ball" cx="70" cy="52" r="8" />
            <line
              class="cue"
              x1={cueEnd().x}
              y1={cueEnd().y}
              x2={PIVOT.x}
              y2={PIVOT.y}
            />
            <circle class="tip" cx={PIVOT.x} cy={PIVOT.y} r="2.4" />
          </svg>
        </div>

        <div class="control">
          <span>menu</span>
          <button class="hamburger" onClick={() => setMenuOpen(true)}>
            ☰
          </button>
        </div>
      </div>

      <Show when={showFsPrompt()}>
        <div class="menu-backdrop" onClick={() => setShowFsPrompt(false)} />
        <div class="fs-prompt">
          <div class="fs-prompt-title">Play fullscreen?</div>
          <p>Go fullscreen and lock to landscape for the best game.</p>
          <div class="fs-prompt-actions">
            <button onClick={enterImmersive}>enter fullscreen</button>
            <button class="ghost" onClick={() => setShowFsPrompt(false)}>
              not now
            </button>
          </div>
        </div>
      </Show>

      <Show when={showA2HS()}>
        <div class="menu-backdrop" onClick={() => setShowA2HS(false)} />
        <div class="fs-prompt">
          <div class="fs-prompt-title">Add to Home Screen</div>
          <p>
            For fullscreen play, tap the Share button{" "}
            <span class="ios-share" aria-hidden="true">
              &#x2191;
            </span>{" "}
            below, then <strong>Add to Home Screen</strong>. Launch pool from the
            new icon.
          </p>
          <div class="fs-prompt-actions">
            <button onClick={() => setShowA2HS(false)}>got it</button>
          </div>
        </div>
      </Show>

      <Show when={menuOpen()}>
        <div class="menu-backdrop" onClick={() => setMenuOpen(false)} />
        <div class="menu-panel">
          <div class="menu-head">
            <span>menu</span>
            <button class="menu-close" onClick={() => setMenuOpen(false)}>
              ✕
            </button>
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
            aim at the cursor and drag away from the cue ball to build power
            (toward it = zero), release to strike · spin pad for draw/follow +
            english · drag the cue widget for elevation · drag the white ball on
            a foul (ball-in-hand)
          </div>
        </div>
      </Show>
    </>
  );
};

export default Game;
