// The Python generators (boulder v5; the fork's dirt and moss) end with
// validators that print one `name: PASS|FAIL ...` line per mesh to stdout, then
// exit non-zero through a traceback on stderr. The stderr tail alone is Blender
// deprecation noise and that traceback, so the verdict lines - the measured
// errors against the tolerance - are pulled out and put first, and the noise is
// dropped. Ported unchanged from the fork's `generatorFailure.ts`.

// How much of the tail is kept (characters, whole lines only).
const TAIL_CHARS = 1200;

export function generatorFailure(label: string, stdout: string, stderr: string, fallback: string, kept: string): string {
  const verdicts = stdout.split(/\r?\n/).filter((line) => /: (PASS|FAIL)\b/.test(line));
  const lines = (stderr || stdout || fallback).split(/\r?\n/);
  const detail: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    // A Python warning is its own line followed by the source line it quotes.
    if (/\bDeprecationWarning:/.test(lines[i]!)) {
      i++;
      continue;
    }
    if (lines[i]!.trim()) detail.push(lines[i]!);
  }
  const tail: string[] = [];
  for (let i = detail.length - 1, size = 0; i >= 0 && size + detail[i]!.length <= TAIL_CHARS; i--) {
    tail.unshift(detail[i]!);
    size += detail[i]!.length + 1;
  }
  return [`${label} failed.`, ...verdicts, `Output kept in ${kept}`, ...tail].join("\n");
}
