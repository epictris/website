import { createSignal, JSX, type Component } from "solid-js";
import { readClipboard, writeClipboard } from "@solid-primitives/clipboard";

import styles from "./App.module.css";
import { createWS } from "@solid-primitives/websocket";
import { useNavigate, useParams } from "@solidjs/router";
import RoomSelect from "./RoomSelect";
import PendingConnection from "./PendingConnection";
import RoomError from "./RoomError";

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
					<i class="fa fa-clipboard fa-lg"></i>
				</button>
			);
		} else if (clipboard.type === ClipboardType.PNG) {
			return (
				<button class="clipboard" onClick={[handleClick, clipboard]}>
					<img src={clipboard.decoded} />
					<i class="fa fa-clipboard fa-lg"></i>
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

const App: Component = () => {
	const [clipboards, setClipboards] = createSignal<ClipboardData[]>([]);
	const [allowPaste, setAllowPaste] = createSignal<boolean>(false);
	const [roomCode, setRoomCode] = createSignal<string | undefined>(undefined);
	const [showError, setShowError] = createSignal<boolean>(false);

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
			let cachedCode = localStorage.getItem("roomCode");
			if (cachedCode) {
				setRoomCode(cachedCode);
				navigator("/" + cachedCode);
			}
		}
	};

	resolveRoomCode();

	const joinRoom = (roomCode: string | undefined) => {
		setRoomCode(roomCode);
		if (roomCode) {
			localStorage.setItem("roomCode", roomCode);
			navigator("/" + roomCode);
		} else {
			localStorage.removeItem("roomCode");
			navigator("/");
		}
	};

	const onMessage = (ev: MessageEvent) => {
		console.log(ev.data);
		if (ev.data instanceof ArrayBuffer) {
			const payload = decodePayload(ev.data);
			if (payload.message.Type == MessageType.CLIPBOARD) {
				decodeClipboard(payload.content, payload.message.ClipboardType).then(
					(clipboard) => setClipboards([clipboard, ...clipboards()]),
				);
			}
		} else {
			const message: StatusMessage = JSON.parse(ev.data);
			if (message.Clients == 2) {
				setAllowPaste(true);
			} else {
				setAllowPaste(false);
			}
		}
	};

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

	const sendClipboard = (content: Blob, type: ClipboardType): void => {
		content.arrayBuffer().then((value) => {
			const encoder = new TextEncoder();
			const message: ClipboardMessage = {
				Type: MessageType.CLIPBOARD,
				ClipboardType: type,
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
			ws.send(sendData);
		});
	};

	const handlePaste = () => {
		readClipboard().then((clipboardItems) => {
			for (let item of clipboardItems) {
				for (let type of item.types) {
					if (Object.values<string>(ClipboardType).includes(type)) {
						item
							.getType(type)
							.then((blob) => sendClipboard(blob, type as ClipboardType));
					}
				}
			}
		});
	};

	const ws = createWS(wsUrlBase + "/ws?id=" + roomCode());
	ws.binaryType = "arraybuffer";
	ws.onmessage = onMessage;
	ws.onerror = () => setShowError(true);

	return (
		<div class={styles.App}>
			<div id="content">
				{showError() ? (
					<RoomError joinRoom={joinRoom} />
				) : (
					<div>
						{!roomCode() && <RoomSelect joinRoom={joinRoom} />}
						{roomCode() && allowPaste() && <Paste handlePaste={handlePaste} />}
						{roomCode() && !allowPaste() && (
							<PendingConnection joinRoom={joinRoom} roomCode={roomCode()} />
						)}
						<br />
						<br />
						{roomCode() && allowPaste() && (
							<Clipboards entries={clipboards()} />
						)}
					</div>
				)}
			</div>
		</div>
	);
};

export default App;
