import { createEffect, createSignal, on, type Component } from 'solid-js';
import { readClipboard, writeClipboard } from "@solid-primitives/clipboard";

import logo from './logo.svg';
import styles from './App.module.css';
import { createWS, createWSState, makeWS } from '@solid-primitives/websocket';
import { redirect, useNavigate } from '@solidjs/router';

const pasteClipboard = (text: string) => {
      fetch(window.location.origin + "/api/paste", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({Value: text})
      })
}

const Paste: Component = () => {

  const handlePaste = () => {
    readClipboard().then((clipboardItems) => {
      for (let item of clipboardItems) {
        if (item.types.includes("text/plain")) {
          item.getType("text/plain").then((value) => value.text().then((text) => pasteClipboard(text)))
          break;
        }
      }
    });
  }

  return (
    <button id="paste" onClick={handlePaste}>PASTE</button>
  );
}

type ClipboardProps = {
  entries: Clipboard[]
}

const Clipboards: Component<ClipboardProps> = (props: ClipboardProps) => {

  const handleClick = (data: Clipboard) => {
    writeClipboard(data.Content);
  }

  return (
    <div id="clipboard-entries">
      {props.entries.map((clipboard) => <button class="clipboard" onClick={[handleClick, clipboard]}><p>{clipboard.Content}</p><i class="fa fa-clipboard fa-lg"></i></button>)}
    </div>
  );
}

enum UpdateType {
  ADD = "append",
  REMOVE = "remove"
}

type Clipboard = {
  Id: number
  Content: string
}

type ClipboardUpdate = {
  Clipboard: Clipboard
  Type: UpdateType
}

function getCookie(name: string): string | undefined {
  const value = `; ${document.cookie}`;
  const parts = value.split(`; ${name}=`);
  if (parts.length === 2) return parts.pop()!.split(';').shift();
}

const App: Component = () => {

  const navigate = useNavigate();

  const [clipboards, setClipboards] = createSignal<Clipboard[]>([]);

  try {
    fetch(window.location.origin + "/api/get_clipboards").then((response) => {
      if (response.status == 401) {
        throw navigate("/login");
      }
      response.json().then((value: {Clipboards: Clipboard[]}) => setClipboards(value.Clipboards));
    });
  } catch (e) {
    console.log(e)
  }

  const ws = createWS("wss://" + window.location.host + "/ws?session_token=" + getCookie("session_token"));
  const onMessage = (ev: MessageEvent) => {
    const update: ClipboardUpdate = JSON.parse(ev.data);
    setClipboards([update.Clipboard, ...clipboards()])
  };
  ws.onmessage = onMessage;

  return (
    <div class={styles.App}>
      <div id="content">
        <Paste />
        <Clipboards entries={clipboards()} />
      </div>
    </div>
  );
};

export default App;
