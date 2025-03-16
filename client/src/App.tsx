import { createEffect, createSignal, JSX, on, type Component } from 'solid-js';
import { readClipboard, writeClipboard } from "@solid-primitives/clipboard";

import logo from './logo.svg';
import styles from './App.module.css';
import { createWS, createWSState, makeWS } from '@solid-primitives/websocket';
import { redirect, useNavigate } from '@solidjs/router';

const pasteClipboard = (type: string, content: string) => {
      fetch(window.location.origin + "/api/paste", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({Type: type, Content: content})
      })
}

async function blobToDataURL(blob: Blob): Promise<string | ArrayBuffer | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
}

const Paste: Component = () => {

  const handlePaste = () => {
    readClipboard().then((clipboardItems) => {
      for (let item of clipboardItems) {
        console.log(item.types);
      }
      for (let item of clipboardItems) {
        if (item.types.includes("text/plain")) {
          item.getType("text/plain")
            .then(value => value.text())
            .then(text => pasteClipboard("text/plain", text))
        } else if (item.types.includes("image/png")) {
          item.getType("image/png")
          .then(blob => blobToDataURL(blob))
          .then(data => {
            if (!(data instanceof ArrayBuffer) && data != null) {
              pasteClipboard("image/png", data)}
            })
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

async function imageToBlob(imgSrc: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = imgSrc;
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.drawImage(img, 0, 0);
        canvas.toBlob((blob) => {
          if (blob) {
            resolve(blob);
          } else {
            reject(new Error("Failed to convert image to blob"));
          }
        }, "image/png");
      }
    }
  })
}

const Clipboards: Component<ClipboardProps> = (props: ClipboardProps) => {

  const handleClick = (data: Clipboard) => {
    if (data.Type === ClipboardType.TEXT) {
      writeClipboard([new ClipboardItem({"text/plain": data.Content})]);
    } else if (data.Type === ClipboardType.PNG) {
      imageToBlob(data.Content).then(blob => writeClipboard([new ClipboardItem({"image/png": blob})]));
    }
  }

  const generateClipboardEntry = (clipboard: Clipboard): JSX.Element => {
    if (clipboard.Type === ClipboardType.TEXT) {
      return <button class="clipboard" onClick={[handleClick, clipboard]}><p>{clipboard.Content}</p><i class="fa fa-clipboard fa-lg"></i></button>
    }
    else if (clipboard.Type === ClipboardType.PNG) {
      return <button class="clipboard" onClick={[handleClick, clipboard]}><img src={clipboard.Content} /><i class="fa fa-clipboard fa-lg"></i></button>
    }
  }

  return (
    <div id="clipboard-entries">
      {props.entries.map(generateClipboardEntry)}
    </div>
  );
}

enum UpdateType {
  ADD = "append",
  REMOVE = "remove"
}

enum ClipboardType {
  TEXT = "text/plain",
  PNG = "image/png"
}

type Clipboard = {
  Id: number
  Content: string
  Type: ClipboardType
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

  const [clipboards, setClipboards] = createSignal<Clipboard[]>([]);

  try {
    fetch(window.location.origin + "/api/get_clipboards").then((response) => {
      response.json().then((value: {Clipboards: Clipboard[]}) => setClipboards(value.Clipboards));
    });
  } catch (e) {
    console.log(e)
  }

  const wsUrlBase = import.meta.env.PROD ? "wss://clipboard.tris.sh" : "ws://localhost:8080";

  const ws = createWS(wsUrlBase + "/ws?session_token=" + getCookie("session_token"));
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
