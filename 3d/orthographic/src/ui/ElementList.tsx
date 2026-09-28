// The object list: search, add / duplicate / delete, visibility and locks.

import { createMemo, For } from "solid-js";
import { deleteSelection, duplicateSelection } from "../actions";
import { updateObject } from "../core/commands";
import { commit, isSelected, report, selectId, setSelection, setUi, state, ui } from "../store";
import { openAddObject } from "./dialogs";
import { CloseIcon, EyeIcon, EyeOffIcon, LockIcon, SearchIcon, UnlockIcon } from "./icons";

export function ElementList() {
  const shown = createMemo(() => {
    const q = ui.search.toLowerCase().trim();
    return state.objects.filter((e) => !q || `${e.id} ${e.name} ${e.kind}`.toLowerCase().includes(q));
  });
  return (
    <aside class="sidebar layers" aria-label="Scene objects">
      <div class="side-head flex">
        <h2 class="grow">Objects</h2>
        <span class="count">{shown().length}</span>
        <button
          type="button"
          class="iconbtn"
          aria-label="Clear selection"
          title="Clear selection (Escape)"
          onClick={() => setSelection([])}
        >
          <CloseIcon />
        </button>
      </div>
      <div class="search">
        <SearchIcon />
        <input
          type="search"
          aria-label="Search objects"
          placeholder="Find an object…"
          value={ui.search}
          onInput={(e) => setUi("search", e.currentTarget.value)}
        />
      </div>
      <div class="object-bar">
        <button type="button" class="btn" title="Add an object (N)" onClick={openAddObject}>
          ＋ Add
        </button>
        <button
          type="button"
          class="btn"
          title="Duplicate the selection (Ctrl/⌘ D)"
          disabled={!ui.selected.length}
          onClick={duplicateSelection}
        >
          Duplicate
        </button>
        <button
          type="button"
          class="btn danger"
          title="Delete the selection"
          disabled={!ui.selected.length}
          onClick={() => deleteSelection()}
        >
          Delete
        </button>
      </div>
      <div class="layer-list">
        <For
          each={shown()}
          fallback={
            <div class="empty-list">
              {state.objects.length ? "No matching objects." : "No objects yet. Add one, or load a project."}
            </div>
          }
        >
          {(e) => (
            <div
              class="layer-row"
              classList={{ selected: isSelected(e.id), "hidden-layer": !e.visible }}
              style={{ "--feature": e.color }}
            >
              <button
                type="button"
                class="select-layer"
                aria-pressed={isSelected(e.id)}
                title={`${e.id} · ${e.name}`}
                onClick={(ev) => selectId(e.id, ev.ctrlKey || ev.metaKey || ev.shiftKey)}
              >
                <span class="swatch" />
                <span class="layer-titles">
                  <span class="layer-id">
                    {e.id}
                    {e.reviewed ? <span style={{ color: "var(--accent)" }}>✓</span> : null}
                  </span>
                  <span class="layer-name">{e.name}</span>
                </span>
              </button>
              <button
                type="button"
                class="mini"
                title={`${e.visible ? "Hide" : "Show"} ${e.id}`}
                aria-label={`${e.visible ? "Hide" : "Show"} ${e.id}`}
                onClick={() => report(commit((d) => updateObject(d, e.id, { visible: !e.visible })))}
              >
                {e.visible ? <EyeIcon /> : <EyeOffIcon />}
              </button>
              <button
                type="button"
                class="mini"
                classList={{ locked: e.locked }}
                title={`${e.locked ? "Unlock" : "Lock"} ${e.id}`}
                aria-label={`${e.locked ? "Unlock" : "Lock"} ${e.id}`}
                onClick={() => report(commit((d) => updateObject(d, e.id, { locked: !e.locked })))}
              >
                {e.locked ? <LockIcon /> : <UnlockIcon />}
              </button>
            </div>
          )}
        </For>
      </div>
      <div class="layer-footer">
        <div>
          {ui.selected.length} selected · {state.objects.filter((e) => !e.visible).length} hidden ·{" "}
          {state.objects.filter((e) => e.locked).length} locked
        </div>
        <p class="note">One closed outline per object in each orthographic view.</p>
      </div>
    </aside>
  );
}
