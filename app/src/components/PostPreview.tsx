import { For, type JSX } from "solid-js";

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
  tooling  = "tooling",
  project  = "project",
  web      = "web",
  game     = "game",
  workflow = "workflow",
}

export function getTagColor(tag: Tag): string {
  switch (tag) {
    case Tag.tooling:  return "#ffd580";
    case Tag.project:  return "#bae67e";
    case Tag.web:      return "#d4bfff";
    case Tag.game:     return "#ff9f94";
    case Tag.workflow: return "#dcabff";
  }
}

export function PostPreview(props: { post: Post }) {
  return (
    <div class="preview-content">
      <div class="preview-right">
        <div class="preview-title">
          <span class="preview-title-hash">#</span> {props.post.title}
        </div>
        <div class="preview-tags">
          <For each={props.post.tags}>
            {tag => (
              <span
                is-="badge"
                cap-="round"
                style={{ "--badge-color": getTagColor(tag), "--badge-text": "#1f2430" }}
              >
                {tag}
              </span>
            )}
          </For>
        </div>
        <p class="preview-desc">{props.post.desc}.</p>
      </div>
      <div class="preview-meta">
        <span class="meta-key">date</span>    <span class="meta-val">{props.post.date}</span>
        <span class="meta-key">kind</span>    <span class="meta-val">post</span>
        <span class="meta-key">reading</span> <span class="meta-val">{props.post.reading} min</span>
        <span class="meta-key">slug</span>    <span class="meta-val">~/post/{props.post.slug}</span>
      </div>
    </div>
  );
}
