import { drawScene, layoutFor } from "./render";
import { rackWorld } from "./physics";
const scale = 360;
for (const [id, rot] of [["c", false], ["cp", true]] as [string, boolean][]) {
  const layout = layoutFor(scale, rot);
  const cv = document.getElementById(id) as HTMLCanvasElement;
  cv.width = layout.W; cv.height = layout.H;
  drawScene(cv.getContext("2d")!, { world: rackWorld(), layout });
}
