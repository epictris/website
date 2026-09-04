// A transient message over the play frame.
//
// It exists for one thing: the P-download's self-replay verdict (see
// `sim/selfReplay.ts`). A bundle that does not reproduce on the machine that
// made it is a finding, and a finding nobody is shown is a finding nobody has.
// The download used to be silent, so a bad bundle looked exactly like a good one
// until it was replayed somewhere else.
//
// Deliberately not part of the game's render: it is DOM over the canvas, so it
// cannot land in a screenshot the renderer takes, cannot cost a frame, and
// cannot be confused for something the player is meant to react to.

const TOAST_ID = "toast";
// Long enough to read two lines without hunting for it, short enough that it is
// gone before the next download.
const TOAST_MS = 6000;

export type ToastTone = "ok" | "warn";

let hideTimer: number | null = null;

function toastElement(): HTMLElement {
  const existing = document.getElementById(TOAST_ID);
  if (existing) return existing;
  const el = document.createElement("div");
  el.id = TOAST_ID;
  el.style.cssText = [
    "position:fixed",
    "left:50%",
    "bottom:24px",
    "transform:translateX(-50%)",
    "max-width:min(90vw,720px)",
    "padding:10px 14px",
    "border-radius:6px",
    "background:#1f2430f2",
    "color:#cbccc6",
    "font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace",
    "white-space:pre-wrap",
    "pointer-events:none",
    "z-index:100",
  ].join(";");
  document.body.appendChild(el);
  return el;
}

export function showToast(text: string, tone: ToastTone = "ok"): void {
  const el = toastElement();
  el.textContent = text;
  el.style.border = `1px solid ${tone === "ok" ? "#313244" : "#d98a5f"}`;
  el.style.display = "block";
  if (hideTimer !== null) clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => {
    el.style.display = "none";
    hideTimer = null;
  }, TOAST_MS);
}
