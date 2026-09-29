// Live scenes: an editor opened with ?scene=<id> works on a scene stored on
// the server. It saves every change back, and follows changes made elsewhere
// (an agent over MCP or HTTP, another tab) through server-sent events, so a
// person and an agent can work on one scene together.
//
// Conflicts are resolved by revision: a save based on an old revision is
// refused, and the editor takes the server's version and says so.

import { createSignal } from "solid-js";
import { image } from "./assets";
import { base64ToBytes } from "./core/images";
import { referencedImages } from "./core/model";
import type { Issue } from "./core/types";
import { currentDocument, loadDocument } from "./io";
import { errors, onSceneChange, setSaveStatus, state, toast } from "./store";

const SAVE_DELAY_MS = 300;
const RETRY_MS = 5000;

/**
 * The editor's own address on this origin (server.ts serves it there, and the
 * API under it), whatever URL the page was opened at. Not Vite's BASE_URL:
 * the dev server leaves that at /.
 */
const editorBase = () => new URL("/orthographic/", location.origin);

const api = (path: string) => new URL(`api/${path}`, editorBase()).href;

/**
 * A response's JSON body. An answer without one (the dev proxy's reply while
 * the API server is down or restarting) becomes an error that says so.
 */
async function json<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      res.ok
        ? "The server's answer could not be read."
        : `The server did not answer (HTTP ${res.status}). It may be starting or restarting; try again in a moment.`,
    );
  }
}

export const [live, setLive] = createSignal<{ id: string; revision: number } | null>(null);

/** The editor link of the live scene. */
export const liveUrl = () => {
  const l = live();
  if (!l) return null;
  const url = editorBase();
  url.search = `?scene=${l.id}`;
  return url.href;
};

/** Image ids the server already holds for this scene. */
const uploaded = new Set<string>();
let applyingRemote = false;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let saving: Promise<void> | null = null;
let saveAgain = false;
let pullWanted = false;
let pointerHeld = false;
let events: EventSource | null = null;

const status = (message: string, ok = true) => setSaveStatus({ message: `Live scene · ${message}`, cached: ok });

export const sceneFromUrl = () => new URLSearchParams(location.search).get("scene");

interface SceneResponse {
  ok: boolean;
  issues: Issue[];
  revision: number;
  document?: unknown;
}

async function fetchScene(id: string): Promise<SceneResponse> {
  const res = await fetch(api(`scenes/${id}?images=data&derived=false`));
  const body = await json<SceneResponse>(res);
  if (!res.ok) throw new Error(body.issues?.[0]?.message ?? `The server answered ${res.status}.`);
  return body;
}

/** Take the server's version of the scene. */
async function apply(body: SceneResponse, undoable: boolean): Promise<boolean> {
  applyingRemote = true;
  try {
    const issues = await loadDocument(body.document, { undoable, keepUi: undoable });
    if (errors(issues).length) {
      toast(`Could not load the live scene: ${errors(issues)[0].message}`, true);
      return false;
    }
  } finally {
    applyingRemote = false;
  }
  for (const id of referencedImages(state)) uploaded.add(id);
  setLive((l) => (l ? { ...l, revision: body.revision } : l));
  return true;
}

async function pull() {
  const l = live();
  if (!l) return;
  // Never swap the scene under a drag; catch up when it ends.
  if (pointerHeld || saving || saveTimer) {
    pullWanted = true;
    return;
  }
  pullWanted = false;
  try {
    const body = await fetchScene(l.id);
    if (body.revision > (live()?.revision ?? 0) && (await apply(body, true)))
      status(`updated to revision ${body.revision}`);
  } catch (e) {
    status(`could not fetch changes: ${(e as Error).message}`, false);
  }
}

async function upload(id: string) {
  const a = image(id);
  if (!a) return;
  const url = api(`scenes/${live()!.id}/images?name=${encodeURIComponent(a.name)}&id=${encodeURIComponent(id)}`);
  const res = await fetch(url, { method: "POST", body: base64ToBytes(a.data) as BlobPart });
  if (!res.ok) throw new Error((await json<SceneResponse>(res)).issues?.[0]?.message ?? `upload ${res.status}`);
  uploaded.add(id);
}

async function save() {
  const l = live();
  if (!l) return;
  status("saving…");
  for (const id of referencedImages(state)) if (!uploaded.has(id)) await upload(id);
  const res = await fetch(api(`scenes/${l.id}`), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      baseRevision: l.revision,
      document: currentDocument({ images: "metadata", derived: false }),
    }),
  });
  const body = await json<SceneResponse>(res);
  if (res.status === 409) {
    toast("Someone else changed this scene at the same time; it now shows their version.", true);
    await apply(await fetchScene(l.id), true);
    status(`revision ${live()!.revision}`);
    return;
  }
  if (!res.ok) {
    toast(`The server refused the change: ${body.issues?.[0]?.message ?? res.status}`, true);
    status("last change not saved", false);
    return;
  }
  setLive({ id: l.id, revision: body.revision });
  status(`saved · revision ${body.revision}`);
}

function queueSave() {
  if (applyingRemote || !live()) return;
  clearTimeout(saveTimer);
  status("unsaved changes", false);
  saveTimer = setTimeout(runSave, SAVE_DELAY_MS);
}

function runSave() {
  saveTimer = undefined;
  if (saving) {
    saveAgain = true;
    return;
  }
  saving = save()
    .catch((e) => {
      status(`offline, retrying: ${(e as Error).message}`, false);
      saveTimer = setTimeout(runSave, RETRY_MS);
    })
    .finally(() => {
      saving = null;
      if (saveAgain) {
        saveAgain = false;
        runSave();
      } else if (pullWanted) pull();
    });
}

function listen(id: string) {
  events?.close();
  events = new EventSource(api(`scenes/${id}/events`));
  events.addEventListener("revision", (e) => {
    const { revision } = JSON.parse((e as MessageEvent).data) as { revision: number };
    if (revision > (live()?.revision ?? 0)) pull();
  });
  events.onerror = () => status("reconnecting…", false);
  events.onopen = () => status(`revision ${live()?.revision ?? "?"}`);
}

function start(id: string, revision: number) {
  setLive({ id, revision });
  listen(id);
  status(`revision ${revision}`);
}

onSceneChange(queueSave);
addEventListener("pointerdown", () => (pointerHeld = true), true);
addEventListener(
  "pointerup",
  () => {
    pointerHeld = false;
    if (pullWanted) setTimeout(pull, SAVE_DELAY_MS * 2);
  },
  true,
);
addEventListener("beforeunload", (e) => {
  if (saveTimer || saving) e.preventDefault();
});

/** Open the live scene named in the URL. Resolves false when there is none or it cannot be loaded. */
export async function openLiveScene(): Promise<boolean> {
  const id = sceneFromUrl();
  if (!id) return false;
  try {
    const body = await fetchScene(id);
    setLive({ id, revision: body.revision });
    if (!(await apply(body, false))) {
      setLive(null);
      return false;
    }
    start(id, body.revision);
    return true;
  } catch (e) {
    toast(`Could not open the live scene: ${(e as Error).message}`, true);
    return false;
  }
}

/** Put the current scene on the server and switch this editor to it. Returns the editor link. */
export async function shareLive(): Promise<string | null> {
  if (live()) return liveUrl();
  try {
    const res = await fetch(api("scenes"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(currentDocument({ images: "data", derived: false })),
    });
    const body = await json<SceneResponse & { sceneId: string }>(res);
    if (!res.ok) throw new Error(body.issues?.[0]?.message ?? `The server answered ${res.status}.`);
    for (const id of referencedImages(state)) uploaded.add(id);
    history.replaceState(null, "", `${editorBase().pathname}?scene=${body.sceneId}`);
    start(body.sceneId, body.revision);
    return liveUrl();
  } catch (e) {
    toast(`Could not share the scene: ${(e as Error).message}`, true);
    return null;
  }
}
