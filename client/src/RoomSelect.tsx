import { Component, createSignal } from "solid-js";

interface RoomSelectProps {
	joinRoom: (roomCode: string) => void;
}

const RoomSelect: Component<RoomSelectProps> = (props) => {
	const { joinRoom } = props;

	const [inputText, setInputText] = createSignal<string>("");

	const generateCode = () => {
		setInputText(Math.random().toString(36).substring(2, 7));
	};

	return (
		<div class="room-select">
			<div>
				<input
					type="text"
					placeholder="Enter room code"
					value={inputText() ?? ""}
					onInput={e => setInputText(e.currentTarget.value)}
					autofocus
					onKeyDown={e => inputText() && e.key === "Enter" && joinRoom(inputText())}
				/>
			</div>
			<div>
				<input type="button" value="Join room" onClick={() => joinRoom(inputText())} disabled={!inputText()}/>
				<input type="button" value="Generate code" onClick={generateCode} />
			</div>
		</div>
	);
};

export default RoomSelect;
