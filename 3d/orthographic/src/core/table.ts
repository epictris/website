// The coordinate table export: one row of bounds per object, as CSV. Pure;
// the editor and the server both write it.

import { fmt } from "./math";
import type { EditorState } from "./types";

const HEADER = [
  "id",
  "name",
  "kind",
  "color",
  "center_x",
  "center_y",
  "center_z",
  "size_x",
  "size_y",
  "size_z",
  "min_x",
  "min_y",
  "min_z",
  "max_x",
  "max_y",
  "max_z",
  "visible",
  "locked",
  "reviewed",
  "notes",
];

export function objectsCsv(s: EditorState): string {
  const rows: (string | number | boolean)[][] = [HEADER];
  for (const e of s.objects) {
    const max = e.min.map((v, i) => v + e.size[i]);
    const center = e.min.map((v, i) => v + e.size[i] / 2);
    rows.push([
      e.id,
      e.name,
      e.kind,
      e.color,
      ...center,
      ...e.size,
      ...e.min,
      ...max,
      e.visible,
      e.locked,
      e.reviewed,
      e.notes,
    ]);
  }
  const cell = (v: string | number | boolean) => {
    let s = typeof v === "number" ? fmt(v, 6) : String(v);
    // A leading = + - @ would run as a formula in a spreadsheet.
    if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  return `﻿${rows.map((r) => r.map(cell).join(",")).join("\r\n")}`;
}
