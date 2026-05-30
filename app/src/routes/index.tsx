import { Title } from "@solidjs/meta";
import { PostReader } from "../components/PostReader";
import { getPost, mostRecentSlug } from "../content/posts";

export default function Home() {
  const post = getPost(mostRecentSlug())!;
  return (
    <>
      <Title>tris.sh</Title>
      <PostReader post={post} />
    </>
  );
}
