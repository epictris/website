// Small UI icons use one stroke vocabulary and remain hidden from screen
// readers; the control itself supplies its accessible name.
export function uiIcon(name: "play" | "close" | "chevron" | "expandAll" | "collapseAll" | "search"): string {
  const paths = {
    play: '<path d="m6 3 8 6-8 6Z"/>',
    close: '<path d="m4 4 10 10M14 4 4 14"/>',
    chevron: '<path d="m6 3 6 6-6 6"/>',
    // Two chevrons opening downward / folding upward: every row of a tree.
    expandAll: '<path d="m4 4 5 4 5-4M4 10l5 4 5-4"/>',
    collapseAll: '<path d="m4 8 5-4 5 4M4 14l5-4 5 4"/>',
    search: '<circle cx="8" cy="8" r="4.5"/><path d="m11.5 11.5 3.5 3.5"/>',
  };
  return `<svg class="studio-icon" width="16" height="16" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
}
