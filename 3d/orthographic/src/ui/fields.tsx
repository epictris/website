// Small input helpers. Inputs show the store's value but never overwrite what
// the user is typing: a focused field keeps its text until it commits.

import { createEffect, type JSX, splitProps } from "solid-js";

type InputProps = Omit<JSX.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & {
  value: string | number;
  onCommit: (value: string, input: HTMLInputElement) => void;
};

/** A text or number input that commits on change (Enter or blur). */
export function Field(props: InputProps) {
  const [own, rest] = splitProps(props, ["value", "onCommit"]);
  let input!: HTMLInputElement;
  createEffect(() => {
    const v = String(own.value);
    if (document.activeElement !== input && input.value !== v) input.value = v;
  });
  return (
    <input
      ref={input}
      {...rest}
      onChange={(e) => {
        own.onCommit(e.currentTarget.value, e.currentTarget);
        // Re-sync with the store in case the commit was rejected or normalised.
        queueMicrotask(() => {
          if (document.activeElement !== input) input.value = String(own.value);
        });
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
    />
  );
}

/** Parse a number field; null for empty or invalid text. */
export const num = (s: string): number | null => {
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

/** A text area that commits on change. */
export function TextArea(
  props: Omit<JSX.TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange"> & {
    value: string;
    onCommit: (v: string) => void;
  },
) {
  const [own, rest] = splitProps(props, ["value", "onCommit"]);
  let el!: HTMLTextAreaElement;
  createEffect(() => {
    if (document.activeElement !== el && el.value !== own.value) el.value = own.value;
  });
  return <textarea ref={el} {...rest} onChange={(e) => own.onCommit(e.currentTarget.value)} />;
}
