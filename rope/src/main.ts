// Entry point: fixed-timestep loop driving the level, live input and renderer.

import { Vec2 } from "./engine/vec2";
import { Level } from "./level/level";
import { BallLevel, FINISH_LINGER_FRAMES } from "./level/ballLevel";
import { SlackChain } from "./classes/slackChain";
import { LiveInputSource } from "./input/liveInput";
import { BallInputSource } from "./input/ballInput";
import { BUTTON_BITS, InputTrace } from "./input/inputTrace";
import { drawProbeOutline, render, renderBall } from "./render/renderer";
import { Scene3D } from "./render3d/scene";
import { BALL_ZOOM, GRAPPLE_ZOOM, type Camera } from "./render/camera";
import { clientToView, fitCanvas, VIEW_HEIGHT, VIEW_WIDTH, viewTransform } from "./render/viewport";
import { CameraController } from "./render/cameraController";
import { PerfProbe } from "./render/perfProbe";
import { drawPerfHud } from "./render/perfHud";
import { drawOpeningFade, openingFadeAlpha } from "./render/openingFade";
import { SparkSystem } from "./render/sparks";
import { DebrisSystem } from "./render/debris";
import { ChainRetract } from "./render/chainRetract";
import { NO_ORBIT } from "./render3d/space";
import { DEFAULT_LEVEL, LEVELS } from "./level/registry";
import { spawnAtCheckpoint } from "./level/levelFormat";
import {
  digest,
  digestBall,
  recordingDeserializer,
  serializeInput,
  worldDigest,
  worldDigestBall,
  type Digest,
  type Recording,
  type SerializedFrame,
  type WorldDigest,
} from "./sim/trace";
import type { FrameInput } from "./input/frameInput";
import type { IInputSource } from "./input/frameInput";
import { levelFromRecording } from "./sim/replay";
import { handleReplayKey, ReplayTransport, type ReplayHost } from "./sim/replayTransport";
import { drawReplayHud, replayBarFrame, replayBarFrameAtX } from "./render/replayHud";
import { PlaytestRecorder } from "./playtest/recorder";
import {
  ADMIN_API,
  DIGEST_EVERY,
  INGEST_PATH,
  PAUSE_RESET_MS,
  type Device,
  type EndReason,
} from "./playtest/protocol";
import { selfReplayLine, verifySelfReplay } from "./sim/selfReplay";
import { showToast } from "./render/toast";
import { showFeedbackForm } from "./render/feedbackForm";
import { readProgress, writeProgress } from "./render/progress";
import { submitFeedback, type Stars } from "./playtest/feedback";
import { LoadingScreen } from "./render/loadingScreen";
// The tree this page was served from, not the commit the dev server booted at
// (see src/sim/treeStamp.ts).
import { commit, dirty, srcHash } from "virtual:tree-stamp";
// ...and the bytes of each authored LEVEL file, which is the narrower stamp a
// piece of feedback is about (see src/sim/treeStamp.ts).
import { levelHashes } from "virtual:level-hashes";

const STEP = 1 / 60;
// One real-time step plus at most one step of catch-up per rendered frame, and
// any deeper debt is shed (see the loop). Five used to be the spiral-of-death
// guard, and five IS the spiral on a machine that cannot afford one: a sim step
// over the render budget put the accumulator permanently behind, every frame
// ran the full five steps, and a vine hang that renders at 75 fps when caught
// up was pinned at 13 fps in 76 ms frames - a 5x amplification of being maybe
// 2x over budget (measured, session-198f at 4x CPU). Shedding the debt trades
// that for sim time running slightly slower than the wall while overloaded,
// which degrades gracefully and recovers instantly.
const MAX_STEPS_PER_FRAME = 5;


// Two canvases stacked on the play frame (see index.html): the WebGL scene
// underneath, and the 2D one on top carrying everything that is genuinely 2D.
// The top canvas keeps the pointer events and the 2D context; the bottom one is
// handed to `Scene3D` and never touched again here.
const canvas = document.getElementById("game") as HTMLCanvasElement;
const sceneCanvas = document.getElementById("scene") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;

// The view is a fixed 16:9 frame (see render/viewport.ts), so the camera's
// viewport is a constant: the window changes how big that frame is drawn, never
// how much world is inside it.
const camera: Camera = {
  position: Vec2.ZERO,
  zoom: GRAPPLE_ZOOM,
  viewportWidth: VIEW_WIDTH,
  viewportHeight: VIEW_HEIGHT,
};
// The camera is driven by the controller (eased follow + camera regions);
// `camera.zoom` is its output, so the framing scale lives here instead.
const cameraCtl = new CameraController();

// Where the frame lands on the canvas — refreshed on resize, since it carries
// the display's DPR as well as the fit.
let view = viewTransform(VIEW_WIDTH, VIEW_HEIGHT);

const params = new URLSearchParams(location.search);

// Level selection via ?level=NAME.
//
// `DEFAULT_LEVEL` is a FALLBACK here and no longer the meaning of a bare URL:
// on `index.html` a page with no `?level=` is the level select and this module
// was never imported at all (see `paintMenu` in render3d/store.ts, and the
// module tag in index.html). What still reaches here with nothing asked for is
// `shot.html` and `cli shot`, which have no menu and want a level to build.
//
// An unknown `?level=` is the store's to answer as well - it shows the menu
// with a line saying so, rather than silently playing something else - so by
// the time this runs the name is one the registry has.
const levelId = ((): string => {
  const requested = params.get("level") ?? DEFAULT_LEVEL;
  return LEVELS[requested] ? requested : DEFAULT_LEVEL;
})();
const levelSpec = LEVELS[levelId]!;
// The bytes of the level FILE this page is playing, when it has one (see
// `virtual:level-hashes`). "" for a level compiled in rather than authored on
// disk, which is every `TEST_*` rig.
const levelHash = levelHashes[levelId] ?? "";
// What the feedback form calls this level. The registry id is a key; the title
// is what the player has just played (see `LevelMetaData.title`).
const levelTitle = levelSpec.data.meta?.title ?? levelId;
const isBall = levelSpec.controller === "ball";
const baseZoom = isBall ? BALL_ZOOM : GRAPPLE_ZOOM;

// Render mode. The ball & chain plays in 3D; the grapple levels stay on the 2D
// path, because the Player state-machine slice is 2D-only (its rig, its rope and
// its ledge overlay are all drawn on the top canvas) and nothing has asked for
// it in 3D yet. `?render=2d` forces the old path anywhere - it is the escape
// hatch for a machine with no working WebGL, and the mode `shot.html` and
// `cli shot` implicitly use.
const wants3d = (params.get("render") ?? (isBall ? "3d" : "2d")) === "3d";

// The alignment probe (`?probe3d=1`): a known world rect drawn as a box in the
// 3D scene and as an outline on the 2D overlay. They must coincide exactly, at
// every zoom and camera position (see `drawProbeOutline`). Placed at the spawn,
// so it is in frame the moment the page loads.
const wantsProbe = params.get("probe3d") !== null;

// A machine with no WebGL gets the 2D renderer rather than a blank page, so a
// failure here is a downgrade and never a crash.
const scene3d = ((): Scene3D | null => {
  if (!wants3d) return null;
  try {
    return new Scene3D(sceneCanvas);
  } catch (err) {
    console.warn("[render3d] WebGL unavailable, falling back to the 2D renderer:", err);
    return null;
  }
})();
if (!scene3d) sceneCanvas.style.display = "none";

// `?dpr=N` draws the frame at a device pixel ratio this display does not have,
// so the fill cost a 4K or HiDPI player pays can be read on a 1080p desk (see
// `fitCanvas`). Everything above the canvas is unaffected: the frame is still
// 1920x1080 view pixels, so the picture is identical and only the number of
// fragments behind it changes. Debug only, and never set in production.
//
// Clamped to 4 because the buffer grows with its SQUARE: at 4 a 1080p window is
// already drawing 33 MP a frame, and a fat-fingered `?dpr=40` would ask for a
// buffer no driver will allocate and lose the context instead of reporting a
// number.
const dprOverride = ((): number | null => {
  const raw = params.get("dpr");
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 4) : null;
})();

function resize(): void {
  view = scene3d
    ? fitCanvas([sceneCanvas, canvas], dprOverride)
    : fitCanvas(canvas, dprOverride);
  scene3d?.resize(view);
}

resize();
window.addEventListener("resize", resize);

// The grey screen `index.html` painted before this module existed, with its bar
// already filling (the inline store has been downloading since first paint - see
// render3d/store.ts). All that is left for the app is to wait for the assets and
// take the screen off: `boot()` at the bottom does the first, and the first
// drawn frame does the second, so nothing is simulated behind it.
const loading = new LoadingScreen();

// Replay mode (`?replay=NAME.json`, fetched from the dev server's public dir):
// feed a recorded session's input stream through the real frame loop instead of
// live input. Same fixed step, same renderer, same digests - it exists so a
// recorded perf complaint can be reproduced on the live page exactly, with
// `?hud=1`/`window.__perf` reading where the frames go. After the last recorded
// frame the final input repeats for ever, holding the end pose steady for a
// settled reading.
//
// The transport (play/pause, speed, seeking) is `sim/replayTransport.ts`; it
// owns WHEN a step runs and nothing else, so the sim sees the recorded inputs in
// the recorded order however the bar is being dragged. Null until the recording
// has landed, which is also what holds the loop still while it is in flight: a
// page that spent the fetch simulating the URL's level on live input would open
// on a run nobody recorded and then throw it away.
let replay: ReplayTransport | null = null;
// The recording being watched. Every level built for the rest of the session
// comes from it (see `makeLevel`): a replayed run that resets mid-way - a jump
// press, a kill zone - has to rebuild the level the RECORDING was played on,
// and the URL's level is not it for a bundle that carries its own geometry or
// started from a checkpoint.
let replayRec: Recording | null = null;
// A build happened while a seek was passing through it, so the 3D scene is of
// bodies that no longer exist (see `buildRun`).
let sceneStale = false;
const replayName = params.get("replay");
// The aim the RECORDED player had on the frame being replayed, drawn where the
// live reticle would be: a replay watched without it shows a ball steering
// itself. Null when the recording says "not aiming", which the ball's input
// source encodes as the ball's own position at sample time (see
// BallInputSource.sample); the replay is exact, so that is an equality test
// against the ball before the step.
let replayAim: Vec2 | null = null;

function recordedAim(l: Level | BallLevel, input: FrameInput): Vec2 | null {
  const aim = input.mouseWorldPosition;
  if (l instanceof BallLevel) {
    const origin = l.ball.globalPosition;
    if (aim.x === origin.x && aim.y === origin.y) return null;
  }
  return aim;
}

// The level as it will be played: `?checkpoint=NAME` moves `player` to the named
// spawn (see `CheckpointData`), so an area halfway through a level can be
// played over and over without swinging out to it first.
//
// Resolved ONCE, here, rather than per build: the level is rebuilt on every
// reset, and a warning about a misspelt name printed on each of them would be a
// console filling up with one mistake. Every level built from it - the first,
// and every one a killzone reset makes - starts at the same place, which is the
// whole point of asking for a checkpoint rather than dragging the spawn.
const checkpoint = params.get("checkpoint");
const levelData = spawnAtCheckpoint(levelSpec.data, checkpoint);

function makeLevel(): Level | BallLevel {
  // While a recording is being watched, every build in the session is the
  // recording's - the first one and every one a reset makes. Built from the URL
  // instead, a replay that crossed a kill zone carried on against the level the
  // page was opened with, which for a self-contained bundle (editor export) or
  // a run played from a checkpoint is a different level entirely, and the frames
  // after the reset were then evidence about nothing.
  if (replayRec) return levelFromRecording(replayRec);
  return isBall ? new BallLevel(levelData) : new Level(levelData, levelSpec.init);
}

let level = makeLevel();

// The hook's sparks (see render/sparks.ts). One system for the session: it is
// fed the sim's per-frame events, advanced on the render clock, and cleared
// with the level.
const sparks = new SparkSystem();
// The chunks breakable geometry comes apart into (see render/debris.ts): the
// same shape as the sparks, and for the same reason - the sim hands it one fact
// per break and it owns everything else.
const debris = new DebrisSystem();
// The released chain reeling back in (see render/chainRetract.ts): the same
// shape as the sparks - it watches the sim each step, runs on the render
// clock, and is cleared with the level.
// Behind `?retract=1` while it is being judged: off, a released chain
// vanishes as it always did.
const chainRetract = params.get("retract") !== null ? new ChainRetract() : null;

// Runs this page has played: the input trace stamps its events with it, so a
// click can be laid beside the frames of the run it landed in.
let resets = 0;

// A fresh level to play, and everything that watched the dead one cleared.
//
// The reset path and the replay transport's rebuild are the same act - a run
// starting from a build - so they are one function: a transport that built its
// levels its own way would be replaying a session the page cannot produce.
function buildRun(): void {
  level = makeLevel();
  // A restart must not carry the dead level's embers, nor the rubble of a wall
  // that is standing again.
  sparks.reset();
  debris.reset();
  chainRetract?.reset();
  level.onReset = reset;
  recFrames.length = 0;
  recDigests.length = 0;
  recWorldDigests.length = 0;
  // A reset builds a new level, so it builds a new scene: every extrusion in it
  // belongs to bodies that no longer exist. Held off while a seek is passing
  // through a build on its way somewhere - the scene it would build is of a
  // frame nobody is going to look at, and rebuilding it is the most expensive
  // thing on the page - and paid once where the seek lands (see `seekEnded`).
  if (replay?.seeking) {
    sceneStale = true;
    return;
  }
  buildScene();
  // Easing in from wherever the camera died would be a swoop across the level.
  cameraCtl.snap();
}

function reset(): void {
  buildRun();
  resets++;
  // The recording's runs are not written down in it (a bundle is a flat frame
  // list), so the transport learns their boundaries from the resets it steps
  // through - which is what makes a seek back into the current run cheap.
  replay?.noteReset();
}
level.onReset = reset;

let probeRect: { x: number; y: number; w: number; h: number } | null = null;

function buildScene(): void {
  if (!scene3d) return;
  scene3d.setLevel(level);
  if (wantsProbe) {
    const at = level.cameraRenderPosition(1);
    probeRect = { x: at.x, y: at.y, w: 4, h: 2 };
  }
  scene3d.setProbe(probeRect);
}
buildScene();

const ballInput = isBall
  ? new BallInputSource(
      canvas,
      camera,
      () => (level as BallLevel).ball.globalPosition,
      // Always the one driving, EXCEPT while a recording is being watched: the
      // aim on screen there is the recorded player's, this source steers
      // nothing, and a source that believes it is driving would take the
      // pointer lock off the first click on the transport bar (see
      // `AimPointer.requestLock`). The game otherwise has no second mode to be
      // idle in, which is the editor's case and not this one.
      () => replayName === null,
      // The canvas hides the OS pointer here (below) and the reticle stands in
      // for it, so the aim may be born above the avatar and travel from there
      // (see `AimPointer`). A test run from the editor passes nothing here: the
      // arrow is still on screen there, and the aim has to stay under it - and
      // nor does a replay, which keeps the desktop cursor for the bar.
      replayName === null,
      // While a level is still opening - the ball rolling in, or the recorded
      // arrival playing back - the player's aim is dropped by the sim, so the
      // cursor is put back above the ball and off the screen when it hands over
      // (see `BallInputSource.handOver`). Read through `level`, which a reset
      // replaces.
      () => level instanceof BallLevel && level.handsOff,
    )
  : null;
// The ball controller draws its own aim reticle (clamped to the chain's reach),
// so the OS cursor would be a second, misleading pointer — hide it. On the
// CANVAS only: the rest of the page keeps the desktop cursor, because the
// loading screen ends at a button and a button is aimed at with the pointer the
// player can see (see `index.html`).
//
// Never while a recording is being watched: the reticle there is the RECORDED
// player's aim and the pointer is the hand on the transport bar, so taking the
// cursor away would leave the scrub bar to be dragged blind.
if (isBall && replayName === null) canvas.style.cursor = "none";
const liveInput = isBall
  ? null
  : new LiveInputSource(canvas, camera, () => (level as Level).player.globalPosition);
const input: IInputSource = (ballInput ?? liveInput)!;

// The raw DOM button story, downloaded beside the frames (see
// input/inputTrace.ts): the frames say what the sim sampled, this says what
// the browser delivered, and a dropped click is found by which one lacks it.
const inputTrace = new InputTrace(
  canvas,
  () => ({ run: resets, frame: level.frame }),
  () => (isBall ? BUTTON_BITS.ball : BUTTON_BITS.grapple),
);
inputTrace.install();

// Full-session recording — press P to download a replayable bundle. A bundle
// must start at level start to replay deterministically, so the trace isn't
// trimmed; it resets whenever the level resets.
const recFrames: SerializedFrame[] = [];
const recDigests: Digest[] = [];
// The rest of the scene, at the same cadence — every rigid body and the chain,
// so a replay of this bundle is compared on the whole world rather than on the
// avatar alone (see WorldDigest).
const recWorldDigests: WorldDigest[] = [];
// The held mask of the most recent sampled frame, which is the hand the NEXT
// level's first frame is stepped from: the input source's previous-frame state
// survives a reset, so a jump still held on the frame after the one that reset
// the level is held, not pressed. A recording that begins there has to say so
// (see `Recording.heldAtStart`).
let lastHeld = 0;
let recHeldAtStart = 0;

function worldDigestOf(l: Level | BallLevel): WorldDigest {
  return l instanceof BallLevel ? worldDigestBall(l) : worldDigest(l);
}

// Production playtest recording (see playtest/recorder.ts): on in a production
// build, off while replaying, and `?record=1` / `?record=0` override either
// way so the whole path can be exercised against a local `serve.ts`.
const recordWanted =
  replayName === null && (params.has("record") ? params.get("record") !== "0" : import.meta.env.PROD);

function detectDevice(): Device {
  if (typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches) return "touch";
  try {
    if (navigator.getGamepads?.().some((g) => g !== null)) return "gamepad";
  } catch {
    // Gamepad access can throw under a restrictive permissions policy; a mouse
    // is then as good a guess as any.
  }
  return "mouse";
}

// `?player=NAME` on an invite link names the first session; it is remembered so
// the name still arrives when the friend comes back by the bare URL.
function playerNick(): string | null {
  const fromUrl = params.get("player")?.trim().slice(0, 40) || null;
  try {
    if (fromUrl) localStorage.setItem("playtest.nick", fromUrl);
    return fromUrl ?? localStorage.getItem("playtest.nick");
  } catch {
    return fromUrl;
  }
}

const recorder = recordWanted
  ? new PlaytestRecorder(INGEST_PATH, {
      commit,
      dirty,
      srcHash,
      level: levelId,
      // The named spawn this page was opened at, so a run streamed from an
      // invite link with `?checkpoint=` replays from where it was played.
      ...(checkpoint ? { checkpoint } : {}),
      // The authored level's own bytes, so a run can be joined to the feedback
      // about the same level file (see `SessionMeta.levelHash`).
      ...(levelHash ? { levelHash } : {}),
      nick: playerNick(),
      device: detectDevice(),
      ua: navigator.userAgent,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      dpr: window.devicePixelRatio,
      render: scene3d ? "3d" : "2d",
    })
  : null;
recorder?.startRun(levelId, 0);

// Restart the level from outside a physics step: the page was hidden for long
// enough that continuing would be a run with a gap in it the fixed step never
// saw, or it came back out of the back/forward cache after its run was ended.
function restartRun(reason: EndReason | null): void {
  if (reason) recorder?.endRun(reason);
  reset();
  recHeldAtStart = lastHeld;
  recorder?.startRun(levelId, lastHeld);
}

let hiddenAt: number | null = null;
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    hiddenAt = performance.now();
    recorder?.flush(true);
  } else if (hiddenAt !== null) {
    const away = performance.now() - hiddenAt;
    hiddenAt = null;
    if (recorder?.isRunOpen && away > PAUSE_RESET_MS) restartRun("pause");
  }
});
window.addEventListener("pagehide", () => recorder?.endRun("unload", true));
window.addEventListener("pageshow", (e) => {
  if (e.persisted && recorder && !recorder.isRunOpen) restartRun(null);
});

function downloadRecording(): void {
  const rec: Recording = {
    // THE LEVEL THAT WAS SIMULATED, which on a replay page is the RECORDING's
    // and not the URL's. A P press while watching a replay is the browser's own
    // re-simulation of that run - which is exactly what a browser-versus-bun
    // check wants - and labelling it with `?level=`'s fallback made the export
    // claim to be a run of `BALL` that diverged on frame 1 against a level it
    // had never touched. Its geometry, its checkpoint and its spawn all come
    // from the recording too (see `makeLevel`), so all three follow it here.
    level: replayRec?.level ?? levelId,
    // `data` AND `controller` together, because they are one statement: a
    // self-contained bundle builds from its embedded geometry and `controller`
    // is what says which driver to build it with (see `Recording.controller`).
    // Carrying the geometry without it re-exported a ball run as a grapple one,
    // which diverges on frame 1 with no ball to steer and no line to cross.
    ...(replayRec?.data ? { data: replayRec.data } : {}),
    ...(replayRec?.controller ? { controller: replayRec.controller } : {}),
    // A bundle names its level rather than embedding it, so a run from a named
    // spawn has to say so or its replay starts at the level's own spawn and
    // diverges on frame 1 (see `Recording.checkpoint`).
    ...(replayRec ? (replayRec.checkpoint ? { checkpoint: replayRec.checkpoint } : {}) : checkpoint ? { checkpoint } : {}),
    git: commit,
    dirty,
    srcHash,
    heldAtStart: recHeldAtStart,
    frames: recFrames.slice(),
    digests: recDigests.slice(),
    worldDigests: recWorldDigests.slice(),
    inputTrace: inputTrace.bundle(),
  };
  // Before the file leaves: does this bundle reproduce HERE? The browser and bun
  // once disagreed on a 1e-17 m overlap and nothing in this path could know it,
  // so the disagreement surfaced hours later on someone else's machine and read
  // as a physics bug (see sim/selfReplay.ts). Run synchronously - a 1000-frame
  // ball session re-simulates in well under a second - and reported either way.
  rec.selfReplay = verifySelfReplay(rec);
  showToast(
    `session-${recFrames.length}f.json\n${selfReplayLine(rec.selfReplay)}`,
    rec.selfReplay.identical ? "ok" : "warn",
  );
  const blob = new Blob([JSON.stringify(rec)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `session-${recFrames.length}f.json`;
  a.click();
  URL.revokeObjectURL(url);
}
// Debug overlay toggle. Render-side only — deliberately outside the
// deterministic FrameInput stream so toggling never affects recordings.
let showDebug = false;
window.addEventListener("keydown", (e) => {
  if (e.code === "KeyP") downloadRecording();
  if (e.code === "KeyL") showDebug = !showDebug;
  if (e.code === "F3") {
    // The browser's own F3 is find-again; a game with an instrument panel on
    // that key does not want it.
    e.preventDefault();
    showPerfHud = !showPerfHud;
  }
});

// What the replay transport drives. It decides when a step runs; the level, the
// scene, the particles and the bundle buffers are all the page's, and this is
// the whole of what it is allowed to do to them.
const replayHost: ReplayHost = {
  rebuild: buildRun,
  step: stepLevel,
  seekEnded: () => {
    // The sparks and the debris are of the frames the seek passed through, not
    // of the one it landed on, and the reeling chain watched a run cross the
    // level in a handful of rendered frames.
    sparks.reset();
    debris.reset();
    chainRetract?.reset();
    if (sceneStale) {
      buildScene();
      sceneStale = false;
    }
    // The camera has been following an avatar that teleported. Easing in from
    // where it was left would be the swoop a reset avoids for the same reason.
    cameraCtl.snap();
  },
};

// The frame under the pointer on the scrub bar, or null when the pointer is
// elsewhere: what a click would seek to, drawn under the pointer so the click
// can be aimed before it is made.
let replayHover: number | null = null;

// The transport's keys, and its scrub bar. Installed only while a recording is
// being watched: they are the replay page's interface and they must not exist on
// the played one, where space is a button and the arrows are movement.
if (replayName) {
  window.addEventListener("keydown", (e) => {
    if (!replay) return;
    // The page scrolls on space and the arrows, and a scrolled page is a game
    // canvas sliding out of the window.
    if (handleReplayKey(replay, e)) e.preventDefault();
  });
  let scrubbing = false;
  const barFrameAt = (e: PointerEvent): number | null => {
    if (!replay) return null;
    const at = clientToView(canvas, e.clientX, e.clientY);
    return replayBarFrame(view, at.x, at.y, replay.frames.length);
  };
  canvas.addEventListener("pointerdown", (e) => {
    const frame = barFrameAt(e);
    if (frame === null || !replay) return;
    scrubbing = true;
    canvas.setPointerCapture(e.pointerId);
    replay.seek(frame);
  });
  canvas.addEventListener("pointermove", (e) => {
    replayHover = barFrameAt(e);
    if (!scrubbing || !replay) return;
    // A drag that has grabbed the bar follows the pointer's HORIZONTAL wherever
    // it goes: a hand dragging a scrubber wanders off it, and a drag that let go
    // the moment it left the panel would be a scrubber that fights back.
    //
    // A seek per pointer move, and the transport takes the newest target: a
    // rewind that has not landed yet is abandoned for wherever the hand has got
    // to, rather than queueing up every frame it passed over.
    const at = clientToView(canvas, e.clientX, e.clientY);
    replay.seek(replayBarFrameAtX(view, at.x, replay.frames.length));
  });
  const endScrub = (e: PointerEvent): void => {
    if (!scrubbing) return;
    scrubbing = false;
    canvas.releasePointerCapture(e.pointerId);
  };
  canvas.addEventListener("pointerup", endScrub);
  canvas.addEventListener("pointercancel", endScrub);
  canvas.addEventListener("pointerleave", () => {
    replayHover = null;
  });
}

// Three places a replay can come from: a file under `public/` (the original,
// for a bundle copied there by hand), `prod/<name>` for a pulled production run
// the dev server serves out of `playtests/prod/`, and `run:<id>` for a run
// fetched straight from the production store, which is what the admin page's
// Watch button opens. The last two are the same bundle at different distances.
function replaySource(name: string): string {
  if (name.startsWith("run:")) return `${ADMIN_API}/runs/${encodeURIComponent(name.slice(4))}`;
  if (name.startsWith("prod/")) return `/playtests/${name}`;
  return `/${name}`;
}

if (replayName) {
  void (async () => {
    const res = await fetch(replaySource(replayName));
    if (!res.ok) {
      showToast(`replay ${replayName}: ${res.status} ${res.statusText}`, "warn");
      return;
    }
    const rec = (await res.json()) as Recording;
    // A run played on a different tree is still worth watching, but it is
    // evidence about that tree and not this one, and the page says so before
    // the first frame rather than leaving it to be noticed.
    if (rec.srcHash && rec.srcHash !== srcHash) {
      showToast(`recorded on ${rec.git ?? rec.srcHash}, this page is ${commit}: the tree differs`, "warn");
    }
    const deserialize = recordingDeserializer(rec);
    const frames = rec.frames.map(deserialize);
    // A self-contained recording (level-editor export) carries its own
    // geometry; play it on that, not on the registry level the URL named. Set
    // before the build, because it is what the build reads (see `makeLevel`).
    replayRec = rec;
    buildRun();
    replay = new ReplayTransport(frames, replayHost);
    // A live handle on the transport, like `window.__perf` is on the probe: a
    // script driving the page (a grab, a headless check) can pause it, seek it
    // and read where it landed without going through the keyboard.
    (window as unknown as { __replay: ReplayTransport }).__replay = replay;
  })();
}

let last = -1;
let accumulator = 0;
// The previous frame callback's wall time, spent in the interval this frame's
// `dt` measures (see `cpuMs` in the loop).
let lastCpuMs = 0;
let fps = 0;

// What the renderer is costing on THIS machine, which is the one thing a
// headless grab cannot report (see render/perfProbe.ts). `window.__perf` is a
// live handle a script can read; the HUD puts the same numbers on the overlay
// for a human. The probe itself is always on - it is a few adds a frame and one
// sort a second - and only the HUD is opt-in.
const perf = new PerfProbe();
(window as unknown as { __perf: typeof perf.snapshot }).__perf = perf.snapshot;
// A live handle on the level being played, the way `__perf` is one on the probe
// and `__replay` is one on the transport: a script driving the page - a grab, a
// headless check of the completion flow - can read where the sim has got to and
// reach into it without going through the keyboard.
//
// A GETTER, because the level is replaced on every reset and a captured
// reference would be of a run that has ended.
Object.defineProperty(window, "__level", { get: () => level, configurable: true });
// The visual chain drape may not cost gameplay a frame: past this much of a
// step it stops iterating and the next step picks up the slack (literally).
// Half a millisecond is 3% of the 60 Hz step and several times what the drape
// costs on an idle machine, so it bites only when the machine is behind - a
// throttled tab, a weak laptop - which is exactly when the sim needs the time.
SlackChain.timeBudgetMs = 0.5;
// `?hud=1` opens the page with it up; F3 toggles it while playing, because the
// frames worth looking at are the ones being played rather than the ones after a
// reload with a different URL.
let showPerfHud = params.get("hud") !== null;

// The JS heap, read on its own slow cadence. `performance.memory` is a
// Chromium-only getter that walks bookkeeping rather than reading a counter, and
// the heap is a level that moves in seconds - reading it every frame would put
// the HUD's own cost into the frame it is measuring. Null everywhere the getter
// does not exist, which the HUD reports as unavailable rather than as 0 MB.
const HEAP_POLL_MS = 250;
let heapMb: number | null = null;
let heapLimitMb: number | null = null;
let heapPolledAt = -Infinity;

function pollHeap(now: number): void {
  if (now - heapPolledAt < HEAP_POLL_MS) return;
  heapPolledAt = now;
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } })
    .memory;
  if (!memory) return;
  heapMb = memory.usedJSHeapSize / (1024 * 1024);
  heapLimitMb = memory.jsHeapSizeLimit / (1024 * 1024);
}

// What the steps of the rendered frame being built have cost, and how many
// there were, for the perf panel. Module level because `stepLevel` is: it runs
// a few times in a played frame, a couple of dozen in a fast-forwarded one and
// as many as the budget buys in a seeking one, and a closure minted per
// rendered frame to carry two numbers is allocation the loop does not need.
let frameSimMs = 0;
let frameSteps = 0;

// One sim step on one input, plus everything outside the sim that watches it.
// The live loop and the replay transport both come through here, so a replayed
// frame is stepped by the same code as a played one.
//
// `seeking` is a replay passing through this frame on its way to another (see
// ReplayTransport): the step is real and the sim sees exactly what it saw the
// first time, but the sparks, the debris and the reeling chain belong to a run
// being watched, and a seek is not watching - fed them, a rewind across a run
// would land holding every ember it had ever thrown.
function stepLevel(frameInput: FrameInput, seeking: boolean): void {
  if (replay) replayAim = recordedAim(level, frameInput);
  const simT0 = performance.now();
  const stepped = level;
  level.physicsProcess(frameInput, STEP);
  frameSimMs += performance.now() - simT0;
  frameSteps++;
  if (!seeking) {
    // Drained inside the catch-up loop rather than after it: a frame that runs
    // several steps would otherwise silently drop every caught-up step's events.
    sparks.ingest(level.sparkEvents);
    // Per step for the same reason: a break that happens on a caught-up step is
    // the only frame its event exists on (see `BallLevel.breakEvents`).
    debris.ingest(level.breakEvents);
    // Likewise per step, so a chain let go and re-thrown across two steps of
    // one render frame is seen as both rather than as nothing having changed.
    chainRetract?.observe(level instanceof BallLevel ? level : null, STEP);
  }
  // The bundle buffers are fed whether or not anyone is watching, so that they
  // hold exactly what has been simulated since the current build: a P download
  // taken after a seek is then the frames from that build to here, which is a
  // bundle that replays, rather than a run with a hole in it.
  const serialized = serializeInput(frameInput);
  lastHeld = serialized.h;
  if (level !== stepped) {
    // The step reset the level (a jump press, or the kill zone). The input
    // belongs to the run that just ended - the old level stepped it - and the
    // fresh level has not seen it, so it is not the first frame of the new run.
    // Recording it as one is what made runs after a reset replay a frame out.
    recorder?.frame(serialized);
    recorder?.digest(worldDigestOf(stepped));
    recorder?.endRun(frameInput.jump.pressed ? "reset" : "kill");
    recHeldAtStart = serialized.h;
    recorder?.startRun(levelId, serialized.h);
  } else {
    recFrames.push(serialized);
    recDigests.push(level instanceof BallLevel ? digestBall(level) : digest(level));
    const wd = worldDigestOf(level);
    recWorldDigests.push(wd);
    recorder?.frame(serialized);
    if (level.frame % DIGEST_EVERY === 0) recorder?.digest(wd);
  }
}

// ---------------------------------------------------------------------------
// Finishing a level
// ---------------------------------------------------------------------------
//
// The player has crossed the finish line (`BallLevel.completedFrame`), the run
// has carried on for `FINISH_LINGER_FRAMES` more steps, and the level is over:
// the loop stops stepping, the pointer comes back, and the form appears over a
// scene that is still being drawn.
//
// STOPPING IS THE PAGE'S, not the sim's. Nothing here reaches into the level:
// it carries on being exactly the level it was, so a P download taken now is a
// bundle that replays and finishes on the same frame, and the recorder's sealed
// run is the frames that were actually played. What changes is that no more of
// them are stepped.
//
// Rendering carries on, which is the point of freezing rather than tearing the
// page down: the form is a panel over the level the player has just finished,
// with the chequers behind it at the pose the last step left.
let frozen = false;
// Null until the crossing. Then the frame the linger ends on, so the check is a
// comparison rather than a second counter to keep in step with the sim's.
let lingerUntil: number | null = null;

// Returns true once stepping should stop for this frame.
function checkCompletion(): boolean {
  if (frozen) return true;
  if (!(level instanceof BallLevel) || level.completedFrame === null) return false;
  if (lingerUntil === null) lingerUntil = level.completedFrame + FINISH_LINGER_FRAMES;
  if (level.frame < lingerUntil) return false;
  frozen = true;
  completeLevel();
  return true;
}

function completeLevel(): void {
  // The run ended because the level was FINISHED, which is a reason of its own:
  // it is neither a reset nor a kill, and a run sealed as either would read as
  // the player having failed at the thing they just did (see `EndReason`).
  recorder?.endRun("complete");
  // The cursor comes back before anything is asked of it. The lock is what the
  // ball's aim took (see `AimPointer`), and the page's own cursor has been
  // hidden since the level started (see `hidePointer`) - so both have to be
  // undone or the form is a dialogue the player cannot point at.
  document.exitPointerLock?.();
  document.documentElement.style.cursor = "";
  const completedFrame = (level as BallLevel).completedFrame ?? 0;
  const was = readProgress()[levelId];
  const stars = (was?.stars ?? null) as Stars | null;

  void showFeedbackForm({
    eyebrow: "Finished",
    title: levelTitle,
    // Pre-filled from the last thing this player said about this level: a
    // re-rating that opened blank would read as the old one having been lost.
    stars,
    comment: was?.comment ?? null,
    submit: ({ stars: gave, comment }) => {
      // LOCALLY FIRST, and then the POST. A dev page with no `serve.ts` beside
      // it and a flaky network are the same case, and in both the level has
      // still been finished: writing progress only on a successful send would
      // lose the completion along with the rating.
      writeProgress(levelId, {
        completedAt: was?.completedAt ?? Date.now(),
        stars: gave,
        comment,
        submittedAt: Date.now(),
      });
      void submitFeedback({
        level: levelId,
        levelHash,
        commit,
        dirty,
        srcHash,
        stars: gave,
        comment,
        // The run that finished it, so a rating can be read beside the play it
        // came out of. A re-rating from the level select carries neither.
        ...(recorder?.session ? { session: recorder.session, run: resets } : {}),
        completedFrame,
      }).then((ok) => {
        if (!ok) showToast("Could not send that - it is saved on this device.", "warn");
      });
    },
    // Skip is a first-class outcome: the level was finished and nothing was
    // said, which is a real answer rather than a missing one.
    skip: () => {
      writeProgress(levelId, {
        completedAt: was?.completedAt ?? Date.now(),
        stars: was?.stars ?? null,
        comment: was?.comment ?? null,
        submittedAt: was?.submittedAt ?? null,
      });
    },
  }).then(() => {
    // Back to the level select, which is where a finished level leads. A
    // navigation rather than an in-page return, for the reason picking a level
    // is one: a session is a page load (see docs/levels.md).
    location.href = "/";
  });
}

function frame(now: number): void {
  // The whole callback's wall time, which is the HUD's "cpu": the share of each
  // frame the main thread is actually busy in. Everything below is inside it,
  // the panel's own drawing included - an instrument that leaves its own cost
  // out of the reading is the wrong instrument.
  const cpuT0 = performance.now();
  // LAST frame's callback over THIS frame's dt, because that is the interval it
  // was spent in: `dt` is the gap since the previous callback started, so the
  // work it contains is the previous callback's. Dividing a callback by the dt
  // measured before it ran reported 339% busy for one 30 ms frame that followed
  // a 9 ms one - a ratio of two different intervals, and a number that cannot
  // mean anything.
  const cpuMs = lastCpuMs;
  if (last < 0) last = now;
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.25) dt = 0.25;
  accumulator += dt;

  // Exponential moving average of the render frame rate.
  if (dt > 0) fps += ((1 / dt) - fps) * 0.1;

  frameSteps = 0;
  frameSimMs = 0;
  if (replay) {
    // A replay's steps are the transport's to schedule: it may run none
    // (paused), sixteen (fast-forward) or fifty-five (paying off a seek).
    replay.pump(dt);
  } else if (replayName === null && !frozen) {
    while (accumulator >= STEP && frameSteps < MAX_STEPS_PER_FRAME) {
      stepLevel(input.sample(), false);
      accumulator -= STEP;
      // The line has been crossed: the run's remaining steps are the LINGER,
      // and when it is spent the loop stops stepping (see `completeLevel`). Checked
      // inside the catch-up loop rather than after it, so a frame that runs
      // several steps cannot overshoot the linger by the rest of them.
      if (checkCompletion()) break;
    }
    // Debt beyond what the capped loop repaid is dropped, keeping only the
    // sub-step remainder for interpolation. Banking it is what turned overload
    // into a death spiral (see MAX_STEPS_PER_FRAME); dropping it means a machine
    // that cannot run 60 sim steps a second plays slightly slowed down instead of
    // at a slideshow frame rate. Recorded bundles are untouched - they capture
    // executed steps, and shedding executes none.
    if (accumulator >= STEP) accumulator %= STEP;
  }
  // A replay page before its recording has landed steps nothing at all: the
  // frames it would run are of the URL's level on live input, and the recording
  // replaces the level the moment it arrives.
  const steps = frameSteps;
  const simMs = frameSimMs;
  // Render interpolation: how far past the last completed physics step this
  // frame lands. The sim runs at a fixed 60 Hz; drawing its raw state on a
  // faster display repeats and skips frames, which reads as jitter. The
  // transport keeps its own remainder, because its step clock runs at a speed.
  const alpha = replay ? replay.alpha : Math.min(1, accumulator / STEP);

  // Once per rendered frame, on the render clock: the sparks are outside the
  // fixed step entirely, like the camera ease.
  sparks.advance(dt);
  debris.advance(dt);

  // Camera: eased follow of the avatar, reshaped by the level's camera regions.
  // Driven by the render dt, so it is frame-rate independent and outside the
  // deterministic fixed step. The default framing centres the avatar; shifting
  // it is a camera region's job (offsetX/offsetY), not a per-controller rule.
  // It follows the *interpolated* avatar, so the two never disagree on screen.
  cameraCtl.update(
    camera,
    dt,
    level.cameraRenderPosition(alpha),
    level.cameraRules,
    baseZoom,
    level.cameraHang,
  );

  // Poll-based aim (gamepad sticks) refreshes per rendered frame, not per
  // physics step, so the reticle/crosshair moves at display rate on a monitor
  // faster than the 60 Hz sim.
  input.pollAim?.();

  // The 3D scene first, then the 2D canvas over it. Both read the same
  // interpolated state at the same `alpha` and the same camera, so they are one
  // picture rather than two that agree most of the time.
  const draw3dT0 = performance.now();
  scene3d?.render(level, camera, alpha, NO_ORBIT, chainRetract);
  const draw3dMs = performance.now() - draw3dT0;

  const draw2dT0 = performance.now();
  if (level instanceof BallLevel) {
    renderBall(
      ctx,
      view,
      level,
      camera,
      fps,
      replay ? replayAim : ballInput!.reticlePoint(),
      alpha,
      scene3d !== null,
      sparks,
      chainRetract,
      debris,
    );
  } else {
    render(
      ctx,
      view,
      level,
      camera,
      fps,
      showDebug,
      replay ? replayAim : liveInput!.crosshairAim(),
      alpha,
      cameraCtl.held,
      scene3d !== null,
      sparks,
      debris,
    );
  }
  const draw2dMs = performance.now() - draw2dT0;

  // The screen a level that opens on a recorded arrival comes up out of (see
  // render/openingFade.ts). Over both canvases - it is drawn on the 2D one,
  // which is on top - and under the instruments below, because a perf panel or
  // a transport bar is the page talking to whoever opened it rather than part
  // of the picture being faded in.
  if (level instanceof BallLevel && level.opensOnArrival) {
    drawOpeningFade(ctx, view, openingFadeAlpha(level.frame + alpha));
  }

  if (probeRect) drawProbeOutline(ctx, view, camera, probeRect);

  // The panel reads the readings the LAST frame produced, which is what lets the
  // sample below cover this frame's own drawing of it.
  if (showPerfHud) drawPerfHud(ctx, view, perf.snapshot, perf.history);

  // The transport bar, over everything, for as long as a recording is being
  // watched (see render/replayHud.ts).
  if (replay) {
    drawReplayHud(ctx, view, {
      index: replay.index,
      total: replay.frames.length,
      paused: replay.paused,
      speed: replay.speed,
      target: replay.target,
      runStarts: replay.runStarts,
      atEnd: replay.atEnd,
      hover: replayHover,
    });
  }

  // After the frame is drawn, so the draw-call and triangle counts are this
  // frame's rather than the last one's, and so the CPU figure covers all of it.
  pollHeap(now);
  perf.sample(dt, scene3d?.renderStats() ?? null, {
    simMs,
    draw3dMs,
    draw2dMs,
    cpuMs,
    // The GPU's own clock, from a query that retired a frame or two ago (see
    // render/gpuTimer.ts). Null on the 2D path, which has no WebGL context to
    // ask.
    gpuMs: scene3d?.gpuFrameMs() ?? null,
    heapMb,
    heapLimitMb,
  });

  // The first frame is also what reveals the level: the loading screen comes off
  // HERE, after this callback has drawn both canvases, so the removal and the
  // picture land in the same compositor frame. Taken off in `boot` instead, the
  // page would show one frame of bare canvas between the bar and the game.
  if (!revealed) {
    revealed = true;
    loading.finish();
  }

  lastCpuMs = performance.now() - cpuT0;
  requestAnimationFrame(frame);
}

// Whether the loading screen has been taken off (see the end of `frame`).
let revealed = false;

// Draw the scene as the first PLAYED frame will draw it, onto the canvas the
// loading screen is covering.
//
// This is what pays a cold frame's costs before anyone is waiting on them.
// Uploading a level's textures (and generating their mip chains), compiling its
// programs and sizing its shadow map all happen on first use, and first use used
// to be the two frames after the download finished: 546 ms of full bar with
// nothing on screen, on a page whose steady-state frame is 1 ms of draw.
//
// SAME CAMERA is the whole of it, and it took three attempts to find. Compiling
// every program in the scene up front cost 278 ms and saved nothing; uploading
// every texture up front saved 80 ms of 450. What was actually happening is that
// the pre-render drew from the camera's INITIAL pose - the origin, because
// `CameraController` had not run yet - so it warmed whatever happened to be at
// the origin, and the first real frame, drawn after the controller had put the
// camera on the avatar, paid the whole cost again for the part of the level that
// is actually on screen. Running the controller first, against the same follow
// point the first frame will use, takes the gap under 100 ms - which is the
// decode of the last file to land, and nothing else.
//
// The warm frame covers the FIRST frame. What it cannot cover is everything
// outside the spawn frustum, which three compiles and uploads on the frame the
// player first scrolls it into view - a lantern 19 m below the spawn cost a
// 15 ms frame and a 45 ms GPU stall 26 s into `session-1697f`. That is what
// `Scene3D.prewarm` pays after the wait, and the load is allowed to take as long
// as it needs: the rule is that nothing is compiled or uploaded on a played
// frame that could have been done here.
function warmFrame(): void {
  if (!scene3d) return;
  cameraCtl.update(
    camera,
    0,
    level.cameraRenderPosition(1),
    level.cameraRules,
    baseZoom,
    level.cameraHang,
  );
  scene3d.render(level, camera, 1);
}

// Fill the screen with the game, from the first click in it (see
// `armFirstClick`).
//
// The whole document rather than the frame, which is what F11 does and what the
// viewport already answers to: the frame is sized to fit whatever it is given
// (see render/viewport.ts), so a fullscreen page is a bigger frame and nothing
// else. It is also what the pointer lock keys off - `AimPointer` takes the lock
// on `fullscreenchange` when the fullscreen element contains the canvas, which
// is the ONE path that needs no second click (entering fullscreen is a gesture
// of its own), and `document.documentElement` contains everything.
//
// A refusal is not an error: a browser that declines fullscreen (or a platform
// with no such thing) still gets the game, windowed, with the click-to-lock path
// the canvas has always had.
function enterFullscreen(): void {
  if (typeof document === "undefined" || document.fullscreenElement) return;
  void Promise.resolve(document.documentElement.requestFullscreen?.()).catch(() => {
    // Refused. The lock the same press has just taken would then be a WINDOWED
    // capture, which is the one thing it is deliberately never allowed to be
    // (see `AimPointer`'s header: locked in a window, Chromium's Wayland pointer
    // drifts out of the page and eats presses), so it goes back.
    document.exitPointerLock?.();
  });
}

// Take the desktop cursor off the whole page, from the moment the level starts.
//
// The canvas has hidden it since the level was chosen, but the canvas is not the
// page: the letterbox bars either side of the frame kept the arrow, and a
// fullscreen window that is wider than 16:9 is mostly bars. It used to happen on
// the PLAY press, because up to there the screen was a button to be clicked and
// the cursor was what you clicked it with; with no press in the way, the start
// of the level is that moment. From here the game's own reticle is the cursor,
// drawn from the first mouse move, which is itself the aim the run opens on
// (see `AimPointer.reveal`).
//
// The ball controller only: the grapple controller aims with the OS pointer
// itself and draws no reticle, so hiding it there would leave nothing to aim
// with.
// A replay keeps its pointer for the same reason the canvas does (see there).
function hidePointer(): void {
  if (isBall && replayName === null) document.documentElement.style.cursor = "none";
}

// Hand the game the screen and the cursor on the player's FIRST CLICK in it.
//
// There is no PLAY button to hang them on any more (see `LoadingScreen`), and
// they are the two things a browser will only grant to a gesture - so the
// gesture is the first press inside the level, which for the ball is the throw
// that opens the run. Nothing is asked of the player that they were not about
// to do, and what they get for it is the game filling the screen from the
// moment they engage with it rather than from a door they had to open first.
//
// ONCE: after this the page is fullscreen and `AimPointer`'s own canvas
// `mousedown` keeps the lock topped up, which is the path that has always
// handled a fullscreen the page did not start (F11, an installed PWA).
//
// The lock FIRST, while the gesture is unspent and the document is plainly the
// focused one: asked any later - from the `fullscreenchange` this same press is
// about to cause - Chrome refuses it outright (see
// `BallInputSource.takePointerLock`), and `enterFullscreen` hands it back if
// fullscreen is then refused.
//
// A replay takes no lock: nothing on the page is aimed, and a locked pointer is
// one that cannot reach the transport bar. It still gets the screen.
function armFirstClick(): void {
  canvas.addEventListener(
    "pointerdown",
    () => {
      if (replayName === null) ballInput?.takePointerLock();
      enterFullscreen();
      // What the click actually got. The two can come apart - a browser may
      // refuse either - and "the cursor is still sitting there" is
      // unattributable without it. Read a beat later because both are
      // asynchronous: the transition and the lock that rides on it land after
      // the handler returns.
      window.setTimeout(() => {
        console.log(
          `[play] fullscreen=${document.fullscreenElement !== null} lock=${document.pointerLockElement === canvas}`,
        );
      }, 500);
    },
    { once: true },
  );
}

// Play once the level's assets are in - or once the loading screen has run out
// of patience with them (see `LoadingScreen.wait`).
//
// Nothing this does reaches a screen anybody can see: the loading screen is
// opaque and covers the page until the first frame of the loop takes it off.
//
// The loop starts AFTER the wait rather than running under the screen, because a
// level stepping behind an opaque rectangle is a run the player never saw: the
// ball would already be falling, and on a slow connection the first thing handed
// over could be a dead one. The recorder agrees - its open run is the run that
// is about to be played.
async function boot(): Promise<void> {
  // Warmed on EVERY frame until the level is in, not on a timer. A timer was
  // written for a slow connection, where there are seconds of waiting to spread
  // the work across; from localhost the whole window between the app booting and
  // the last decode landing is about 200 ms, so a 150 ms tick fired once, warmed
  // a scene that was still mostly fallback textures, and left the real upload to
  // pile up into one 309 ms frame after the bar was already full.
  let warming = true;
  const warmLoop = (): void => {
    if (!warming) return;
    warmFrame();
    requestAnimationFrame(warmLoop);
  };
  requestAnimationFrame(warmLoop);
  await loading.wait();
  warming = false;
  // The last arrivals, which no warm frame covered.
  warmFrame();
  // Then everything the warm frame's camera cannot see (see `Scene3D.prewarm`).
  // Awaited under the screen: the frame loop, and the run, start after it.
  if (scene3d) {
    const warmed = await scene3d.prewarm(level, camera);
    console.log(
      `[prewarm] ${warmed.programs} programs, ${warmed.textures} textures in ${warmed.ms.toFixed(0)} ms`,
    );
  }
  // Everything is loaded, warm and drawn, so the level STARTS. There is nothing
  // else to wait for: choosing it on the level select was the press (Tris,
  // 2026-09-20), and a second one in front of a room that is already lit is a
  // door held shut.
  //
  // The two grants the press used to buy move to the FIRST CLICK IN THE GAME,
  // which is the same argument the press was made on - "the one click the
  // player has to make anyway" - with the click that throws the first hook
  // standing in for the one that used to start the level. Until it lands the
  // level is windowed and aims with the real pointer, which is a mode the game
  // already has (see `AimPointer`: the lock is deliberately never taken outside
  // fullscreen, because Chromium's Wayland pointer drifts out of a windowed
  // capture and eats presses).
  //
  // The desktop cursor still goes here rather than there, and earlier than it
  // used to: the canvas has hidden it since the level was chosen, and this
  // takes it off the letterbox bars either side, which are page rather than
  // canvas. The game's own reticle replaces it from the first mouse move (see
  // `AimPointer.reveal`).
  hidePointer();
  armFirstClick();
  requestAnimationFrame(frame);
}
void boot();
