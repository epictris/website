import { render } from "solid-js/web";
import { Route, Router, useNavigate } from "@solidjs/router";
import { onMount, type Component } from "solid-js";
import Game from "./Game";
import "./styles.css";

// Generate a short random room code (URL-safe, no lookalike chars).
function newCode(): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(7));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

const RoomResolver: Component = () => {
  const navigate = useNavigate();
  onMount(() => navigate("/" + newCode(), { replace: true }));
  return null;
};

render(
  () => (
    <Router>
      <Route path="/" component={RoomResolver} />
      <Route path="/:room" component={Game} />
    </Router>
  ),
  document.getElementById("root")!,
);
