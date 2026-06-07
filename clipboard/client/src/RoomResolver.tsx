import { useNavigate } from "@solidjs/router";
import { Component } from "solid-js";

const generateNewCode = (): string => {
	return "aaaaaaa"
		.split("")
		.map((char) =>
			String.fromCharCode(char.charCodeAt(0) + Math.floor(Math.random() * 26)),
		)
		.join("");
};

const RoomResolver: Component = () => {
	const navigate = useNavigate();
	const roomCode: string =
		localStorage.getItem("roomCode") ?? generateNewCode();
	navigate("/" + roomCode);
	return <></>;
};

export default RoomResolver;
