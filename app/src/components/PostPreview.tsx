import { createContext, For, type JSX, useContext } from "solid-js";

export type Post = {
	slug: string;
	title: string;
	desc: string;
	tags: Tag[];
	date: string;
	reading: number;
	/** Full post content. Absent posts fall back to the snapshot card. */
	body?: () => JSX.Element;
};

export enum Tag {
	tooling = "tooling",
	project = "project",
	web = "web",
	game = "game",
	workflow = "workflow",
	life = "life",
}

export const TagClickContext = createContext<(tag: string) => void>();

const tagColors: Record<Tag, string> = {
	[Tag.tooling]: "#ffd580",
	[Tag.project]: "#bae67e",
	[Tag.web]: "#d4bfff",
	[Tag.game]: "#ff9f94",
	[Tag.workflow]: "#dcabff",
	[Tag.life]: "#ffd4f2",
};

export function getTagColor(tag: Tag): string {
	return tagColors[tag];
}

export function PostPreview(props: { post: Post }) {
	const onTagClick = useContext(TagClickContext);
	return (
		<div class="preview-content">
			<div class="preview-right">
				<div class="preview-title">
					<span class="preview-title-hash">#</span> {props.post.title}
				</div>
				<div class="preview-tags">
					<For each={props.post.tags}>
						{(tag) => (
							// biome-ignore lint/a11y/useSemanticElements: WebTUI badge, must be span
							<span
								is-="badge"
								cap-="round"
								data-tag-badge
								role="button"
								tabIndex="0"
								style={{
									"--badge-color": getTagColor(tag),
									"--badge-text": "#1f2430",
									cursor: "pointer",
								}}
								onClick={() => onTagClick?.(tag)}
								onKeyDown={(e) => {
									if (e.key === "Enter" || e.key === " ") {
										e.preventDefault();
										onTagClick?.(tag);
									}
								}}
							>
								{tag}
							</span>
						)}
					</For>
				</div>
				<p class="preview-desc">{props.post.desc}</p>
			</div>
			<div class="preview-meta">
				<For
					each={[
						["date", props.post.date],
						["kind", "post"],
						["reading", `${props.post.reading} min`],
						["author", "Tristan Bray"],
					]}
				>
					{([key, value]) => (
						<>
							<span class="meta-key">{key}</span>
							<span class="meta-val">{value}</span>
						</>
					)}
				</For>
			</div>
		</div>
	);
}
