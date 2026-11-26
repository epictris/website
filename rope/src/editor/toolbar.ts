// THE TOOLBAR (docs/editor.md "The toolbar"): every workspace's tools as
// Blender shows its own - a column of icons floating over the viewport's
// left edge, in blocks of related tools, the active one lit. What a tool is
// called, its key and what it does are its tooltip, shown beside it.
//
// The buttons stay the editor's own (their handlers, their `active` and
// `aria-pressed` state, their `title`s set wherever the editor sets them);
// this only gives them an icon and a name, and the column its blocks.

import { toolIcon, type ToolIconName } from "./toolIcons";

// Make a button a toolbar tool: its icon for a face, its name for its
// accessible label and its tooltip's heading.
export function toolize(b: HTMLButtonElement, name: string, icon: ToolIconName): HTMLButtonElement {
  b.classList.add("ed-tool");
  b.innerHTML = toolIcon(icon);
  setToolName(b, name);
  return b;
}

// A tool whose name depends on where it is (the path tool: a curve on the
// scene layer, a path on the camera's).
export function setToolName(b: HTMLButtonElement, name: string, icon?: ToolIconName): void {
  b.dataset["toolName"] = name;
  b.setAttribute("aria-label", name);
  if (icon) b.innerHTML = toolIcon(icon);
}

// A block of related tools.
export function toolBlock(...tools: HTMLElement[]): HTMLElement {
  const g = document.createElement("div");
  g.className = "ed-tb-group";
  g.append(...tools);
  return g;
}

// One workspace's tools: its blocks, top to bottom.
export function toolSet(label: string, ...blocks: HTMLElement[]): HTMLElement {
  const s = document.createElement("div");
  s.className = "ed-tb-set";
  s.setAttribute("role", "toolbar");
  s.setAttribute("aria-orientation", "vertical");
  s.setAttribute("aria-label", label);
  s.append(...blocks);
  return s;
}

// THE TOOLBAR'S WIDTH, for what stands beside it (the view bar, the jobs, the
// transform readout: `--toolbar-w` on `root`). A column too tall for the
// window carries on in a second, and a column-wrapping flex box does not grow
// wider for its extra columns, so the width is measured off the blocks
// themselves: whenever the toolbar's height changes (the window) and when
// `fit` is called (a workspace, a layer or a selection changed which blocks
// show).
export function watchToolbarWidth(toolbar: HTMLElement, root: HTMLElement): () => void {
  const fit = (): void => {
    const left = toolbar.getBoundingClientRect().left;
    let right = left;
    for (const g of toolbar.querySelectorAll<HTMLElement>(".ed-tb-group")) {
      if (!g.offsetParent) continue;
      right = Math.max(right, g.getBoundingClientRect().right);
    }
    root.style.setProperty("--toolbar-w", `${Math.ceil(right - left)}px`);
  };
  new ResizeObserver(fit).observe(toolbar);
  return fit;
}

// A block is shown while any tool in it is.
export function refreshBlocks(set: HTMLElement): void {
  for (const g of set.querySelectorAll<HTMLElement>(":scope > .ed-tb-group")) {
    const any = [...g.children].some((c) => (c as HTMLElement).style.display !== "none");
    g.style.display = any ? "" : "none";
  }
}

// THE TOOLTIP: the tool's name and key, then what it does, beside the tool,
// after the pointer rests on it (or the keyboard reaches it). A tool's
// description is its `title`, which the editor sets and resets as it pleases;
// it is taken into the tooltip as the pointer arrives, so the browser's own
// never shows over this one.
export function installToolTips(host: HTMLElement): void {
  const tip = document.createElement("div");
  tip.className = "ed-tooltip";
  tip.setAttribute("role", "tooltip");
  tip.hidden = true;
  host.appendChild(tip);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let over: HTMLButtonElement | null = null;
  const hide = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    over = null;
    tip.hidden = true;
  };
  const adopt = (b: HTMLButtonElement): void => {
    if (b.title) {
      b.dataset["tip"] = b.title;
      b.removeAttribute("title");
    }
  };
  const show = (b: HTMLButtonElement): void => {
    adopt(b);
    const head = document.createElement("div");
    head.className = "ed-tooltip-head";
    const name = document.createElement("strong");
    name.textContent = b.dataset["toolName"] ?? "";
    head.appendChild(name);
    const key = b.dataset["shortcut"];
    if (key) {
      const k = document.createElement("kbd");
      k.textContent = key;
      head.appendChild(k);
    }
    tip.replaceChildren(head);
    const text = b.dataset["tip"];
    if (text) {
      const p = document.createElement("p");
      p.textContent = text;
      tip.appendChild(p);
    }
    tip.hidden = false;
    const r = b.getBoundingClientRect();
    const h = tip.getBoundingClientRect().height;
    tip.style.left = `${Math.round(r.right + 10)}px`;
    tip.style.top = `${Math.round(Math.max(8, Math.min(window.innerHeight - h - 8, r.top)))}px`;
  };
  const toolOf = (t: EventTarget | null): HTMLButtonElement | null =>
    t instanceof Element ? (t.closest(".ed-tool") as HTMLButtonElement | null) : null;
  host.addEventListener("pointerover", (e) => {
    const b = toolOf(e.target);
    if (b === over) return;
    hide();
    if (!b) return;
    over = b;
    adopt(b);
    timer = setTimeout(() => show(b), 450);
  });
  host.addEventListener("pointerout", (e) => {
    if (toolOf(e.relatedTarget) !== over) hide();
  });
  host.addEventListener("pointerdown", hide, true);
  host.addEventListener("focusin", (e) => {
    const b = toolOf(e.target);
    if (b && b.matches(":focus-visible")) {
      over = b;
      show(b);
    }
  });
  host.addEventListener("focusout", hide);
  window.addEventListener("keydown", hide, true);
}
