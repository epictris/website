import { Component, createSignal } from "solid-js";

interface RoomSelectProps {
	joinRoom: (roomCode: string) => void;
}

const RoomSelect: Component<RoomSelectProps> = (props) => {
	const { joinRoom } = props;

	const [inputText, setInputText] = createSignal<string>("");

	const randomRoomCode = "aaaaaa"
		.split("")
		.map((char) =>
			String.fromCharCode(char.charCodeAt(0) + Math.floor(Math.random() * 26)),
		)
		.join("");

	return (
		<div class="room-select">
			<div>
				<input
					type="text"
					placeholder={randomRoomCode}
					value={inputText() ?? ""}
					onInput={(e) => setInputText(e.currentTarget.value)}
					autofocus
					onKeyDown={(e) =>
						e.key === "Enter" && joinRoom(inputText() || randomRoomCode)
					}
				/>
			</div>
			<div>
				<input
					type="button"
					value="Use this clipboard code"
					onClick={() => joinRoom(inputText() || randomRoomCode)}
				/>
			</div>
		</div>
	);
};

export default RoomSelect;
