// A DROPDOWN MENU on a button in the editor's top bar (the File menu): a
// column of commands under the button, a flyout to the side of an entry that
// holds more (File > Open's levels), rules between runs of them.
//
// The entries are built each time the menu opens, so what they say (which
// level is open, whether there is a file to delete) is never stale. A pick
// closes the menu before it runs. Esc, a press anywhere else and the window
// losing focus close it too. The keyboard works it as a desktop menu does:
// the arrows move between entries and into and out of a flyout, Enter or
// Space picks, Home and End go to the ends; no key reaches the editor's own
// shortcuts while it is open.

export type MenuEntry =
  | {
      kind: "item";
      label: string;
      run: () => void;
      // What the command does, as its tooltip.
      title?: string;
      disabled?: boolean;
      // Lit with a tick: the level that is open, a panel that is showing.
      checked?: boolean;
      danger?: boolean;
    }
  | { kind: "sub"; label: string; entries: () => MenuEntry[]; title?: string }
  // Said in place of a flyout's entries when it has none.
  | { kind: "note"; label: string }
  | { kind: "sep" };

export function menuButton(label: string, entries: () => MenuEntry[]): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ed-btn ed-menu-button";
  btn.textContent = label;
  btn.setAttribute("aria-haspopup", "menu");
  btn.setAttribute("aria-expanded", "false");
  // The open menu and its flyout, outermost first.
  const open: HTMLElement[] = [];

  const close = (refocus: boolean): void => {
    for (const m of open) m.remove();
    open.length = 0;
    btn.setAttribute("aria-expanded", "false");
    btn.classList.remove("active");
    document.removeEventListener("pointerdown", outside, true);
    window.removeEventListener("blur", blur);
    if (refocus) btn.focus();
  };
  const outside = (e: PointerEvent): void => {
    if (e.target instanceof Node && (btn.contains(e.target) || open.some((m) => m.contains(e.target as Node)))) return;
    close(false);
  };
  const blur = (): void => close(false);

  const itemsOf = (m: HTMLElement): HTMLButtonElement[] =>
    [...m.querySelectorAll<HTMLButtonElement>(":scope > .ed-menu-item")].filter((b) => !b.disabled);

  // Drop the flyouts deeper than `depth` (the menu at `depth` stays).
  const closeFrom = (depth: number): void => {
    while (open.length > depth + 1) open.pop()!.remove();
    open[depth]?.querySelector(".ed-menu-item.open")?.classList.remove("open");
  };

  const build = (list: MenuEntry[], depth: number): HTMLElement => {
    const m = document.createElement("div");
    m.className = "ed-menu";
    m.setAttribute("role", "menu");
    // Focusable itself, so a menu opened by a click takes the keys at once.
    m.tabIndex = -1;
    m.addEventListener("keydown", (e) => key(e, m, depth));
    for (const entry of list) {
      if (entry.kind === "sep") {
        const s = document.createElement("div");
        s.className = "ed-menu-sep";
        s.setAttribute("role", "separator");
        m.appendChild(s);
        continue;
      }
      if (entry.kind === "note") {
        const n = document.createElement("div");
        n.className = "ed-menu-note";
        n.textContent = entry.label;
        m.appendChild(n);
        continue;
      }
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ed-menu-item";
      b.tabIndex = -1;
      const tick = document.createElement("span");
      tick.className = "ed-menu-tick";
      tick.setAttribute("aria-hidden", "true");
      const text = document.createElement("span");
      text.className = "ed-menu-label";
      text.textContent = entry.label;
      b.append(tick, text);
      if (entry.title) b.title = entry.title;
      if (entry.kind === "item") {
        b.setAttribute("role", entry.checked === undefined ? "menuitem" : "menuitemcheckbox");
        if (entry.checked !== undefined) b.setAttribute("aria-checked", String(entry.checked));
        if (entry.checked) tick.textContent = "✓";
        b.disabled = entry.disabled === true;
        if (entry.danger) b.classList.add("danger");
        b.addEventListener("click", () => {
          close(true);
          entry.run();
        });
        // Passing over a plain entry closes a flyout another one opened. The
        // pointer moves the focus as the arrows do, so one entry is lit.
        b.addEventListener("pointerenter", () => {
          closeFrom(depth);
          if (!b.disabled) b.focus();
        });
      } else {
        b.setAttribute("role", "menuitem");
        b.setAttribute("aria-haspopup", "menu");
        const arrow = document.createElement("span");
        arrow.className = "ed-menu-arrow";
        arrow.setAttribute("aria-hidden", "true");
        arrow.textContent = "▸";
        b.appendChild(arrow);
        const flyout = (focusFirst: boolean): void => {
          if (b.classList.contains("open")) {
            if (focusFirst) itemsOf(open[depth + 1]!)[0]?.focus();
            return;
          }
          closeFrom(depth);
          b.classList.add("open");
          const sub = build(entry.entries(), depth + 1);
          document.body.appendChild(sub);
          open.push(sub);
          const r = b.getBoundingClientRect();
          const s = sub.getBoundingClientRect();
          const left = r.right + s.width + 4 <= window.innerWidth ? r.right + 2 : r.left - s.width - 2;
          sub.style.left = `${Math.round(Math.max(4, left))}px`;
          sub.style.top = `${Math.round(Math.max(4, Math.min(window.innerHeight - s.height - 4, r.top - 5)))}px`;
          if (focusFirst) itemsOf(sub)[0]?.focus();
        };
        b.addEventListener("pointerenter", () => {
          b.focus();
          flyout(false);
        });
        b.addEventListener("click", () => flyout(true));
        b.addEventListener("keydown", (e) => {
          if (e.key === "ArrowRight") {
            e.preventDefault();
            e.stopPropagation();
            flyout(true);
          }
        });
      }
      m.appendChild(b);
    }
    return m;
  };

  const key = (e: KeyboardEvent, m: HTMLElement, depth: number): void => {
    // The editor's shortcuts are on the window; a menu's keys are its own.
    e.stopPropagation();
    const items = itemsOf(m);
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const go = (i: number): void => items[(i + items.length) % items.length]?.focus();
    if (e.key === "ArrowDown") go(at + 1);
    else if (e.key === "ArrowUp") go(at < 0 ? -1 : at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(-1);
    else if (e.key === "Escape" || (e.key === "ArrowLeft" && depth > 0)) {
      if (depth === 0) close(true);
      else {
        const opener = open[depth - 1]?.querySelector<HTMLButtonElement>(".ed-menu-item.open");
        closeFrom(depth - 1);
        opener?.focus();
      }
    } else if (e.key === "Tab") close(false);
    else return;
    e.preventDefault();
  };

  const show = (focusFirst: boolean): void => {
    const m = build(entries(), 0);
    document.body.appendChild(m);
    open.push(m);
    const r = btn.getBoundingClientRect();
    m.style.left = `${Math.round(Math.min(r.left, window.innerWidth - m.getBoundingClientRect().width - 4))}px`;
    m.style.top = `${Math.round(r.bottom + 4)}px`;
    btn.setAttribute("aria-expanded", "true");
    btn.classList.add("active");
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("blur", blur);
    if (focusFirst) itemsOf(m)[0]?.focus();
    else m.focus();
  };

  btn.addEventListener("click", (e) => {
    if (open.length) close(false);
    // A click from the keyboard (Enter, Space) starts on the first entry.
    else show(e.detail === 0);
  });
  btn.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" || open.length) return;
    e.preventDefault();
    e.stopPropagation();
    show(true);
  });
  return btn;
}
