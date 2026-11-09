// Small UI icons use one stroke vocabulary and remain hidden from screen
// readers; the control itself supplies its accessible name.
export function uiIcon(name: "play" | "close" | "chevron"): string {
  const paths = {
    play: '<path d="m6 3 8 6-8 6Z"/>',
    close: '<path d="m4 4 10 10M14 4 4 14"/>',
    chevron: '<path d="m6 3 6 6-6 6"/>',
  };
  return `<svg class="studio-icon" width="16" height="16" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
}
