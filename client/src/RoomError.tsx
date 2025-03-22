import { Component, createSignal } from "solid-js";

interface RoomSelectProps {
	joinRoom: (roomCode: string | undefined) => void;
}

const RoomError: Component<RoomSelectProps> = (props) => {
	const { joinRoom } = props;

	return (
		<div class="room-error">
			<p> This room is already in use. <br/> <br/></p>
			<div>
				<input
					type="button"
					value="Use a different clipboard"
					onClick={() => joinRoom(undefined)}
				/>
			</div>
		</div>
	);
};

export default RoomError;
