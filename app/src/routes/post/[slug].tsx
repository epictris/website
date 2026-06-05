import { Title } from "@solidjs/meta";
import { A, useParams } from "@solidjs/router";
import { HttpStatusCode } from "@solidjs/start";
import { Show } from "solid-js";
import { PostReader } from "../../components/PostReader";
import { getPost } from "../../content/posts";

export default function PostPage() {
  const params = useParams();
  const post = () => (params.slug ? getPost(params.slug) : undefined);

  return (
    <Show
      when={post()}
      fallback={
        <>
          <Title>Not found — tris.sh</Title>
          <HttpStatusCode code={404} />
          <p class="no-results">
            no post named "{params.slug}" — <A href="/">go home</A>
          </p>
        </>
      }
    >
      {(p) => (
        <>
          <Title>{p().title} — tris.sh</Title>
          <PostReader post={p()} />
        </>
      )}
    </Show>
  );
}
