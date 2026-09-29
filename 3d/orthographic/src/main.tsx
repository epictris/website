import { createEffect, on } from "solid-js";
import { render } from "solid-js/web";
import { installApi } from "./api";
import { restoreAtStartup } from "./io";
import { schedule } from "./meshes";
import { state } from "./store";
import { App } from "./ui/App";
import "./styles.css";

render(() => {
  // Rebuild solids whenever outlines or boxes change.
  createEffect(
    on(
      () => JSON.stringify(state.objects.map((e) => [e.id, e.size, e.parts])),
      () => schedule(),
    ),
  );
  return <App />;
}, document.getElementById("root")!);
installApi();
restoreAtStartup();
