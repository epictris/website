import { Component } from "solid-js";

interface PendingConnectionProps {
	joinRoom: (roomCode: string | undefined) => void;
	roomCode?: string;
}

const PendingConnection: Component<PendingConnectionProps> = (props) => {
	const { joinRoom, roomCode } = props;

	return (
		<div class="pending-connection">
			<div>
				<p class="code">{roomCode}</p>
				<br />
				<p>
					Enter this code on another device.
					<br />
					<br />
					Or navigate to: clipboard.tris.sh/{roomCode}
					<br />
					<br />
					<br />
				</p>
			</div>
			<div>
				<input
					type="button"
					value="Use a different code"
					onClick={() => joinRoom(undefined)}
				/>
			</div>
		</div>
	);
};

export default PendingConnection;
