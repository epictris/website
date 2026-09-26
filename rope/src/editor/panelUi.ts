// The inspector's two pieces of furniture that are about reading the panel
// rather than about any one property: collapsible SECTIONS, and the HELP popup
// that says what a property or a section is for.
//
// Sections are collapsed until opened, and an opened one stays open. The
// inspector is rebuilt on nearly every edit and every selection change, so a
// section's state cannot live on its element: it is keyed by a name that is
// the same for every object of a kind ("collision/Surface"), remembered for the
// page and in localStorage, so opening Surface once opens it on the next wall
// too - and on the next visit.
//
// Help used to be paragraphs under the fields, which made the panel mostly
// prose. It is attached to a NAME now (a field's label, a section's or a
// group's title), marked with a dotted underline, and shown in a popup beside
// the panel while the pointer rests on that name and at no other time.

const STORAGE_KEY = "rope.editor.openSections";

const openSections: Set<string> = (() => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(list) ? list.filter((k): k is string => typeof k === "string") : []);
  } catch {
    return new Set<string>();
  }
})();

function rememberOpen(key: string, open: boolean): void {
  if (open) openSections.add(key);
  else openSections.delete(key);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...openSections]));
  } catch {
    // Storage refused (private window, blocked site data): the state still
    // holds for this page, which is all it is for.
  }
}

function setOpen(sec: HTMLElement, open: boolean): void {
  sec.classList.toggle("open", open);
  const twist = sec.querySelector(":scope > .ed-sec-head > .ed-sec-twist");
  if (twist) twist.textContent = open ? "▾" : "▸";
}

// A collapsible section appended to `parent`, returning the element its
// fields go in. `key` names it for the remembered open state; `title` is what
// the header says, and may change from one build to the next ("Node 3") while
// the key does not. `top` draws the header as a group heading, for a section
// that is a group of its own (Level, Environment) rather than part of one.
//
// A section left empty is dropped by `pruneEmptySections`, so a builder can
// open one before it knows whether anything applies.
export function section(parent: HTMLElement, key: string, title: string, top = false): HTMLElement {
  const sec = document.createElement("div");
  sec.className = top ? "ed-sec top" : "ed-sec";
  sec.dataset["key"] = key;
  const head = document.createElement("div");
  head.className = "ed-sec-head";
  const twist = document.createElement("span");
  twist.className = "ed-sec-twist";
  const name = document.createElement("span");
  name.className = "ed-name";
  name.textContent = title;
  head.append(twist, name);
  head.addEventListener("click", () => {
    const open = !sec.classList.contains("open");
    setOpen(sec, open);
    rememberOpen(key, open);
  });
  const body = document.createElement("div");
  body.className = "ed-sec-body";
  sec.append(head, body);
  setOpen(sec, openSections.has(key));
  parent.appendChild(sec);
  return body;
}

// Open the section `el` sits in (and every section around it), for a field
// the editor puts the caret in itself: a freshly placed note's text.
export function revealInSection(el: HTMLElement): void {
  for (let sec = el.closest<HTMLElement>(".ed-sec"); sec; sec = sec.parentElement?.closest<HTMLElement>(".ed-sec") ?? null) {
    if (sec.classList.contains("open")) continue;
    setOpen(sec, true);
    rememberOpen(sec.dataset["key"] ?? "", true);
  }
}

// Drop the sections nothing was put in: the builders open one per concern and
// several concerns apply only to some kinds of body.
export function pruneEmptySections(root: HTMLElement): void {
  for (const body of root.querySelectorAll<HTMLElement>(".ed-sec-body")) {
    if (!body.childElementCount) body.parentElement?.remove();
  }
}

// A field row: the name, then whatever control or readout is appended to it.
// The name is its own element so help can be hung on it and on nothing else.
export function fieldRow(label: string, tag: "label" | "div" = "label", cls = "ed-field"): HTMLElement {
  const row = document.createElement(tag);
  row.className = cls;
  const name = document.createElement("span");
  name.className = "ed-name";
  name.textContent = label;
  row.appendChild(name);
  return row;
}

// A group's title: what is selected. Help on it describes the group.
export function heading(text: string, help?: string): HTMLElement {
  const h = document.createElement("div");
  h.className = "ed-heading";
  const name = document.createElement("span");
  name.className = "ed-name";
  name.textContent = text;
  h.appendChild(name);
  if (help) describe(h, help);
  return h;
}

// --- help ---------------------------------------------------------------------

const helpOf = new WeakMap<Element, string[]>();

// Hang `text` on the name `target` is labelled by: a field row's name (or the
// row of the input handed in), a section's header, a heading's text. A second
// call adds a paragraph rather than replacing the first.
export function describe(target: HTMLElement, text: string): void {
  if (!text) return;
  const owner = target.closest<HTMLElement>(".ed-field, .ed-sec, .ed-heading") ?? target;
  const anchor = owner.classList.contains("ed-name")
    ? owner
    : (owner.querySelector<HTMLElement>(".ed-name") ?? owner);
  const paras = helpOf.get(anchor) ?? [];
  paras.push(text);
  helpOf.set(anchor, paras);
  anchor.classList.add("has-help");
  installHelp();
}

const SHOW_DELAY_MS = 250;
let tip: HTMLElement | null = null;
let shownFor: Element | null = null;
let pending: { anchor: Element; timer: number } | null = null;

function hide(): void {
  if (pending) window.clearTimeout(pending.timer);
  pending = null;
  shownFor = null;
  if (tip) tip.style.display = "none";
}

// `code` spans are the level format's own words; everything else is prose.
function render(paras: readonly string[]): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const text of paras) {
    const p = document.createElement("p");
    text.split("`").forEach((part, i) => {
      if (!part) return;
      if (i % 2) {
        const c = document.createElement("code");
        c.textContent = part;
        p.appendChild(c);
      } else p.appendChild(document.createTextNode(part));
    });
    frag.appendChild(p);
  }
  return frag;
}

function show(anchor: Element): void {
  const paras = helpOf.get(anchor);
  if (!paras || !anchor.isConnected) return;
  tip ??= Object.assign(document.createElement("div"), { className: "ed-tip" });
  if (!tip.isConnected) document.body.appendChild(tip);
  tip.replaceChildren(render(paras));
  tip.style.display = "block";
  shownFor = anchor;
  // Beside the panel rather than over it, so the field being read about stays
  // in view: to the left of the inspector (it hugs the right edge), or of the
  // name itself anywhere else, and to the right when there is no room.
  const r = anchor.getBoundingClientRect();
  const panel = anchor.closest(".ed-inspector")?.getBoundingClientRect() ?? r;
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  const gap = 8;
  let x = panel.left - gap - w;
  if (x < gap) x = Math.min(panel.right + gap, window.innerWidth - w - gap);
  const y = Math.max(gap, Math.min(r.top - 5, window.innerHeight - h - gap));
  tip.style.left = `${Math.max(gap, x)}px`;
  tip.style.top = `${y}px`;
}

let installed = false;
function installHelp(): void {
  if (installed) return;
  installed = true;
  document.addEventListener("pointerover", (e) => {
    const anchor = (e.target as Element | null)?.closest?.(".has-help") ?? null;
    if (anchor === shownFor || anchor === pending?.anchor) return;
    hide();
    if (!anchor) return;
    pending = { anchor, timer: window.setTimeout(() => show(anchor), SHOW_DELAY_MS) };
  });
  document.addEventListener("pointerout", (e) => {
    const into = e.relatedTarget as Node | null;
    const current = shownFor ?? pending?.anchor ?? null;
    if (current && !(into && current.contains(into))) hide();
  });
  // The inspector rebuilds under a resting pointer (an edit, a refresh), and a
  // name that is taken out of the page fires no pointerout: its popup would
  // hang there describing nothing.
  document.addEventListener("pointermove", () => {
    if (shownFor && !shownFor.isConnected) hide();
  });
  document.addEventListener("pointerdown", hide, true);
  document.addEventListener("wheel", hide, { capture: true, passive: true });
  document.addEventListener("keydown", hide, true);
}

export const PANEL_UI_CSS = `
  /* A name keeps its width and the control beside it gives way (a picker
     shrinks, see the inspector's own rule); a generator's schema key, which
     can be longer than the panel, is the exception (ed-gen-label). */
  .ed-name { flex: none; overflow: hidden; text-overflow: ellipsis; }
  .ed-name.has-help { text-decoration: underline dotted #5b6172; text-underline-offset: 3px;
    cursor: help; }
  .ed-field > .ed-text { flex: 1 1 auto; width: auto; min-width: 0; }
  .ed-sec { display: flex; flex-direction: column; gap: 4px; }
  .ed-sec-head { display: flex; gap: 1ch; align-items: baseline; cursor: pointer;
    color: #cbccc6; user-select: none; }
  .ed-sec-head:hover { color: #65bddb; }
  .ed-sec-head .ed-name.has-help { cursor: pointer; }
  .ed-sec-twist { flex: none; width: 1ch; color: #6b7280; }
  .ed-sec-head:hover .ed-sec-twist { color: #65bddb; }
  .ed-sec-body { display: flex; flex-direction: column; gap: 4px; padding-left: 2ch; }
  .ed-sec:not(.open) > .ed-sec-body { display: none; }
  .ed-sec.top > .ed-sec-head { color: #65bddb; border-bottom: 1px solid #313244;
    padding-bottom: 2px; }
  .ed-sec.top > .ed-sec-body { padding-left: 0; }
  .ed-tip { position: fixed; z-index: 1001; display: none; box-sizing: border-box;
    max-width: 340px; padding: 6px 8px; background: #1f2430; border: 1px solid #3c445c;
    border-radius: 2px; box-shadow: 0 4px 16px rgba(0,0,0,0.5); color: #cbccc6;
    font-family: monospace; font-size: 13px; line-height: 1.45; pointer-events: none; }
  .ed-tip p { margin: 0; }
  .ed-tip p + p { margin-top: 6px; }
  .ed-tip code { color: #65bddb; font-family: inherit; }
`;
