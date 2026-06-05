import { createResource, createSignal, Suspense } from "solid-js";

const cache = new Map<string, Promise<string>>();

async function doHighlight(code: string, lang: string): Promise<string> {
  const { codeToHtml } = await import("shiki");
  return codeToHtml(code, { lang, theme: "ayu-dark" });
}

function highlight(code: string, lang: string): Promise<string> {
  const key = `${lang}:${code}`;
  let promise = cache.get(key);
  if (!promise) {
    promise = doHighlight(code, lang);
    cache.set(key, promise);
  }
  return promise;
}

function copyCode(code: string, setCopied: (v: boolean) => void) {
  navigator.clipboard.writeText(code).then(() => {
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  });
}

export function CodeBlock(props: { code: string; lang?: string }) {
  const [html] = createResource(
    () => ({ code: props.code.trim(), lang: props.lang ?? "bash" }),
    ({ code, lang }) => highlight(code, lang),
  );
  const [copied, setCopied] = createSignal(false);

  return (
    <div class="code-block">
      <Suspense fallback={<pre>{props.code.trim()}</pre>}>
        <div innerHTML={html()} />
      </Suspense>
      <button
        type="button"
        class="code-block-copy"
        onClick={() => copyCode(props.code.trim(), setCopied)}
      >
        {copied() ? "\u{f00c}" : "\u{f0c5}"}
      </button>
    </div>
  );
}
