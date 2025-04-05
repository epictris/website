import { createEffect, createSignal, JSX, type Component } from "solid-js";
import { readClipboard, writeClipboard } from "@solid-primitives/clipboard";

import styles from "./App.module.css";
import { createWS } from "@solid-primitives/websocket";
import { useNavigate, useParams } from "@solidjs/router";
import { usePageVisibility } from "@solid-primitives/page-visibility";

async function blobToDataURL(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onloadend = () => {
			if (reader.result == null) {
				reject(new Error("Failed to convert blob to data URL"));
			} else if (reader.result instanceof ArrayBuffer) {
				reject(new Error("Failed to convert blob to data URL"));
			} else {
				resolve(reader.result);
			}
		};
		reader.readAsDataURL(blob);
	});
}

enum MessageType {
	STATUS = "connect",
	CLIPBOARD = "clipboard",
}

type StatusMessage = {
	Type: MessageType.STATUS;
	Clients: number;
};

type ClipboardMessage = {
	Type: MessageType.CLIPBOARD;
	ClipboardType: ClipboardType;
	Id: string;
};

type Payload = {
	message: Message;
	content: ArrayBuffer;
};

type Message = ClipboardMessage | StatusMessage;

type PasteProps = {
	handlePaste: () => void;
};

const Paste: Component<PasteProps> = (props) => {
	const { handlePaste } = props;

	return (
		<button id="paste" onClick={handlePaste}>
			PASTE
		</button>
	);
};

type ClipboardProps = {
	entries: ClipboardData[];
};

const Clipboards: Component<ClipboardProps> = (props: ClipboardProps) => {
	const handleClick = (clipboard: ClipboardData) => {
		writeClipboard([
			new ClipboardItem({
				[clipboard.type]: new Blob([clipboard.raw], { type: clipboard.type }),
			}),
		]);
	};

	const generateClipboardEntry = (clipboard: ClipboardData): JSX.Element => {
		if (clipboard.type === ClipboardType.TEXT) {
			return (
				<button class="clipboard" onClick={[handleClick, clipboard]}>
					<p>{clipboard.decoded}</p>
					<i class="far fa-copy fa-lg"></i>
				</button>
			);
		} else if (clipboard.type === ClipboardType.PNG) {
			return (
				<button class="clipboard" onClick={[handleClick, clipboard]}>
					<img src={clipboard.decoded} />
					<i class="far fa-copy fa-lg"></i>
				</button>
			);
		}
	};

	return (
		<div id="clipboard-entries">
			{props.entries.map(generateClipboardEntry)}
		</div>
	);
};
enum ClipboardType {
	TEXT = "text/plain",
	PNG = "image/png",
}

type ClipboardData = {
	decoded: string;
	raw: ArrayBuffer;
	type: ClipboardType;
};

const generateNewCode = (): string => {
	return "aaaaaaa"
		.split("")
		.map((char) =>
			String.fromCharCode(char.charCodeAt(0) + Math.floor(Math.random() * 26)),
		)
		.join("");
};

const App: Component = () => {
	const getRoomCode = (): string => {
		return (
			useParams().roomCode ??
			localStorage.getItem("roomCode") ??
			generateNewCode()
		);
	};

	const [clipboards, setClipboards] = createSignal<
		Record<string, ClipboardData>
	>({});
	const [connectedClients, setConnectedClients] = createSignal<number>(1);
	const [roomCode, setRoomCode] = createSignal<string>(getRoomCode());
	const [ws, setWs] = createSignal<globalThis.WebSocket | null>(null);

	const visible = usePageVisibility();

	createEffect(() => {
		const activeWs = ws();
		if (!activeWs) {
			return;
		}
		if (visible()) {
			if (activeWs.readyState == 3) {
				console.log("reconnecting");
				setTimeout(initWs, 200);
			}
		}
	});

	const wsUrlBase = import.meta.env.PROD
		? "wss://clipboard.tris.sh"
		: "ws://localhost:8080";

	const navigator = useNavigate();

	const resolveRoomCode = () => {
		let code: string | undefined | null = useParams().roomCode;
		if (code) {
			localStorage.setItem("roomCode", code);
			setRoomCode(code);
		} else {
			code = localStorage.getItem("roomCode") ?? generateNewCode();
			setRoomCode(code);
			navigator("/" + code);
		}
	};

	resolveRoomCode();

	const cutArrayByDelimiter = (
		array: ArrayBuffer,
		delimiter: Uint8Array,
	): { head: ArrayBuffer; tail: ArrayBuffer } => {
		const delimiterString = String.fromCharCode(...delimiter);

		for (let i = 0; i <= array.byteLength - delimiter.length; i++) {
			const slice = array.slice(i, i + delimiter.length);
			const sliceString = String.fromCharCode(...new Uint8Array(slice));

			if (sliceString === delimiterString) {
				return {
					head: array.slice(0, i),
					tail: array.slice(i + delimiter.length),
				};
			}
		}
		return { head: new ArrayBuffer(), tail: new ArrayBuffer() };
	};

	function decodePayload(content: ArrayBuffer): Payload {
		const encoder = new TextEncoder();
		const { head, tail } = cutArrayByDelimiter(
			content,
			encoder.encode("\r\n\r\n"),
		);
		const message: Message = JSON.parse(
			String.fromCharCode(...new Uint8Array(head)),
		);
		return { message, content: tail };
	}

	async function decodeClipboard(
		clipboard: ArrayBuffer,
		type: ClipboardType,
	): Promise<ClipboardData> {
		const decoder = new TextDecoder();
		if (type === ClipboardType.TEXT) {
			return {
				type: ClipboardType.TEXT,
				decoded: decoder.decode(clipboard),
				raw: clipboard,
			};
		} else if (type === ClipboardType.PNG) {
			return await blobToDataURL(new Blob([clipboard])).then((dataURL) => {
				return { type: ClipboardType.PNG, decoded: dataURL, raw: clipboard };
			});
		}
		throw new Error("Failed to decode clipboard");
	}

	const sendClipboard = (
		content: Blob,
		type: ClipboardType,
		id: string,
	): void => {
		content.arrayBuffer().then((value) => {
			const activeWs = ws();
			if (!activeWs) {
				return;
			}
			const encoder = new TextEncoder();
			const message: ClipboardMessage = {
				Type: MessageType.CLIPBOARD,
				ClipboardType: type,
				Id: id,
			};
			const buf1 = encoder.encode(JSON.stringify(message));
			const buf2 = encoder.encode("\r\n\r\n");
			const buf3 = value;
			let sendData = new Uint8Array(
				buf1.byteLength + buf2.byteLength + buf3.byteLength,
			);
			sendData.set(new Uint8Array(buf1), 0);
			sendData.set(new Uint8Array(buf2), buf1.byteLength);
			sendData.set(new Uint8Array(buf3), buf1.byteLength + buf2.byteLength);

			activeWs.send(sendData);
		});
	};

	const handlePaste = () => {
		readClipboard().then((clipboardItems) => {
			for (let item of clipboardItems) {
				for (let type of item.types) {
					if (Object.values<string>(ClipboardType).includes(type)) {
						item
							.getType(type)
							.then((blob) =>
								sendClipboard(
									blob,
									type as ClipboardType,
									(Object.keys(clipboards()).length + 1).toString(),
								),
							);
					}
				}
			}
		});
	};

	const onMessage = (ev: MessageEvent) => {
		console.log(ev.data);
		if (ev.data instanceof ArrayBuffer) {
			const payload = decodePayload(ev.data);
			if (payload.message.Type == MessageType.CLIPBOARD) {
				const id = payload.message.Id;
				decodeClipboard(payload.content, payload.message.ClipboardType).then(
					(clipboard) => setClipboards({ [id]: clipboard, ...clipboards() }),
				);
			}
		} else {
			const message: StatusMessage = JSON.parse(ev.data);
			setConnectedClients(message.Clients);
			for (let [id, clipboard] of Object.entries(clipboards())) {
				sendClipboard(
					new Blob([clipboard.raw], { type: clipboard.type }),
					clipboard.type,
					id,
				);
			}
		}
	};

	const onClose = (e: CloseEvent) => {
		console.log("connection closed", e);
	};

	const onError = (e: Event) => {
		console.log("connection error", e);
	};

	const initWs = () => {
		if (!roomCode()) {
			return;
		}
		const ws = createWS(wsUrlBase + "/ws?id=" + roomCode());
		ws.binaryType = "arraybuffer";
		ws.onmessage = onMessage;
		ws.onerror = onError;
		ws.onclose = onClose;
		setWs(ws);
	};

	initWs();

	const interceptKeyEvent = (e: KeyboardEvent) => {
		console.log(e.key);
		switch (e.key) {
			case "v":
				if (e.ctrlKey || e.metaKey) {
					handlePaste();
				}
		}
	};

	return (
		<div
			class={styles.App}
			autofocus
			tabindex="0"
			onKeyDown={interceptKeyEvent}
		>
			<div id="content">
				<div id="banner">
					<div>
						<h2>Sharing clipboard</h2>
						<br />
						{connectedClients() == 1 ? (
							<p>
								Open{" "}
								<a href={"https://clipboard.tris.sh/" + roomCode()}>
									clipboard.tris.sh/{roomCode()}
								</a>{" "}
								on another device to access this clipboard.
							</p>
						) : (
							<p>
								<b>{connectedClients()}</b> devices viewing this clipboard.
							</p>
						)}
					</div>
					<div id="icon">
						<div onClick={(_) => handlePaste()}>
							<i class="fas fa-2x fa-paste"></i>
						</div>
					</div>
				</div>
				<div>
					<br />
					{roomCode() && <Clipboards entries={Object.values(clipboards())} />}
				</div>
			</div>
		</div>
	);
};

export default App;
