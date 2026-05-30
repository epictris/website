import { createResource, Suspense } from "solid-js";

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

export function CodeBlock(props: { code: string; lang?: string }) {
	const [html] = createResource(
		() => ({ code: props.code.trim(), lang: props.lang ?? "bash" }),
		({ code, lang }) => highlight(code, lang),
	);

	return (
		<Suspense fallback={<pre>{props.code.trim()}</pre>}>
			<div class="code-block" innerHTML={html()} />
		</Suspense>
	);
}
