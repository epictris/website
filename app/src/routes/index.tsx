import { Title } from "@solidjs/meta";
import { PostShell } from "../components/PostShell";
import { mostRecentSlug } from "../content/posts";

export default function Home() {
  return (
    <>
      <Title>tris.sh</Title>
      <PostShell activeSlug={mostRecentSlug()} defaultOpen />
    </>
  );
}
