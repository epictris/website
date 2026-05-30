import { Show } from "solid-js";
import { type Post, PostPreview } from "./PostPreview";

/**
 * Renders a single post: the snapshot header (title / tags / desc / meta)
 * followed by its full body. Posts without a body show the snapshot only.
 */
export function PostReader(props: { post: Post }) {
	return (
		<article class="reader">
			<div class="post-preview">
				<PostPreview post={props.post} />
			</div>
			<Show when={props.post.body}>
				{(body) => (
					<>
						<br />
						<div class="post-body">{body()()}</div>
					</>
				)}
			</Show>
		</article>
	);
}
