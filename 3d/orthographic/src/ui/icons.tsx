// Line icons (24 x 24, stroke = currentColor via the .icon class).

import type { JSX } from "solid-js";

const Icon = (props: { children: JSX.Element; style?: JSX.CSSProperties }) => (
  <svg class="icon" viewBox="0 0 24 24" aria-hidden="true" style={props.style}>
    {props.children}
  </svg>
);

export const ImagePlusIcon = () => (
  <Icon>
    <rect height="16" rx="2" width="18" x="3" y="4" />
    <path d="M12 8v8m-4-4h8" />
  </Icon>
);
export const ExpandIcon = () => (
  <Icon>
    <path d="M8 3H3v5 M16 3h5v5 M3 16v5h5 M21 16v5h-5" />
  </Icon>
);
export const BrandIcon = () => (
  <Icon style={{ width: "25px", height: "25px" }}>
    <path d="m3 8 9-5 9 5v9l-9 5-9-5Z M3 8l9 5 9-5 M12 13v9 M7 6l9 5v8" />
  </Icon>
);
export const UndoIcon = () => (
  <Icon>
    <path d="M8 4 3 9l5 5 M3 9h11a7 7 0 0 1 0 14" transform="translate(0 -2)" />
  </Icon>
);
export const RedoIcon = () => (
  <Icon>
    <path d="m16 4 5 5-5 5 M21 9H10a7 7 0 0 0 0 14" transform="translate(0 -2)" />
  </Icon>
);
export const FolderIcon = () => (
  <Icon>
    <path d="M3 7h7l2 3h9l-3 10H3Z M3 7V4h7l2 3" />
  </Icon>
);
export const SaveIcon = () => (
  <Icon>
    <path d="M4 3h13l4 4v14H3V3Z M7 3v7h10V3 M7 21v-7h10v7" />
  </Icon>
);
export const ChevronIcon = () => (
  <Icon>
    <path d="m7 10 5 5 5-5" />
  </Icon>
);
export const HelpIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.5 9a2.5 2.5 0 0 1 5 .5c0 2-2.5 2-2.5 4 M12 17h.01" />
  </Icon>
);
export const MoveIcon = () => (
  <Icon>
    <path d="M12 3v18 M3 12h18 M9 6l3-3 3 3 M9 18l3 3 3-3 M6 9l-3 3 3 3 M18 9l3 3-3 3" />
  </Icon>
);
export const ResizeIcon = () => (
  <Icon>
    <path d="M5 9v10h10 M19 15V5H9 M12 12l7-7" />
  </Icon>
);
export const OutlineIcon = () => (
  <Icon>
    <path d="m5 6 13-2 3 14-15 3Z" />
    <rect height="4" width="4" x="3" y="4" />
    <rect height="4" width="4" x="16" y="2" />
    <rect height="4" width="4" x="19" y="16" />
    <rect height="4" width="4" x="4" y="19" />
  </Icon>
);
export const FitIcon = () => (
  <Icon>
    <path d="M8 3H3v5 M16 3h5v5 M3 16v5h5 M21 16v5h-5 M8 8h8v8H8Z" />
  </Icon>
);
export const CloseIcon = () => (
  <Icon>
    <path d="m7 7 10 10 M17 7 7 17" />
  </Icon>
);
export const SearchIcon = () => (
  <Icon>
    <circle cx="10" cy="10" r="6" />
    <path d="m15 15 5 5" />
  </Icon>
);
export const EyeIcon = () => (
  <Icon>
    <path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6S2 12 2 12Z" />
    <circle cx="12" cy="12" r="2.5" />
  </Icon>
);
export const EyeOffIcon = () => (
  <Icon>
    <path d="m3 3 18 18 M10 6h2c6 0 10 6 10 6s-1 2-4 4 M6 6c-3 2-4 6-4 6s4 6 10 6c1 0 2 0 3-.5" />
  </Icon>
);
export const LockIcon = () => (
  <Icon>
    <rect x="5" y="10" width="14" height="11" rx="2" />
    <path d="M8 10V7a4 4 0 0 1 8 0v3 M12 14v3" />
  </Icon>
);
export const UnlockIcon = () => (
  <Icon>
    <rect x="5" y="10" width="14" height="11" rx="2" />
    <path d="M8 10V7a4 4 0 0 1 8 0 M12 14v3" />
  </Icon>
);
