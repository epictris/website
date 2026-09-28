import { createEffect, on } from "solid-js";
import { render } from "solid-js/web";
import { installApi } from "./api";
import { restoreAtStartup } from "./io";
import { initMesher, schedule } from "./meshes";
import { state } from "./store";
import { App } from "./ui/App";
import "./styles.css";

initMesher();
render(() => {
  // Rebuild solids whenever outlines or the sampling resolution change.
  createEffect(
    on(
      () => [JSON.stringify(state.objects.map((e) => [e.id, e.outlines])), state.reconstruction.resolution],
      () => schedule(),
    ),
  );
  return <App />;
}, document.getElementById("root")!);
installApi();
restoreAtStartup();
