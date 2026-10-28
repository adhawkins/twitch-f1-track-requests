"use strict";

const trackList = document.getElementById("track-list");
const tracksElement = document.getElementById("tracks");

function render(state) {
	const fragment = document.createDocumentFragment();

	for (const request of state.requests) {
		const added = request.completed;
		const item = document.createElement("li");
		item.className = `track ${added ? "track--added" : "track--not-added"}`;
		item.textContent = request.trackName;
		item.setAttribute("aria-label", `${request.trackName}: ${added ? "complete" : "not complete"}`);
		item.dataset.completed = String(added);
		fragment.append(item);
	}

	tracksElement.replaceChildren(fragment);
	requestAnimationFrame(() => {
		if (trackList.scrollHeight <= trackList.clientHeight) {
			trackList.scrollTop = 0;
			return;
		}

		const firstIncomplete = tracksElement.querySelector('[data-completed="false"]');
		if (!firstIncomplete) return;
		const listBounds = trackList.getBoundingClientRect();
		const itemBounds = firstIncomplete.getBoundingClientRect();
		trackList.scrollTop += itemBounds.top - listBounds.top
			- (trackList.clientHeight - firstIncomplete.offsetHeight) / 2;
	});
}

function connect() {
	const url = new URL("/api/events", window.location.href);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	const socket = new WebSocket(url);

	socket.addEventListener("message", event => {
		let message;
		try {
			message = JSON.parse(event.data);
		} catch (error) {
			console.error("Invalid message from track status server.", error);
			return;
		}
		if (message.type !== "page-state" || !message.state
			|| !Array.isArray(message.state.tracks) || !Array.isArray(message.state.requests)) {
			return;
		}
		render(message.state);
	});
	socket.addEventListener("error", event => {
		console.error("Track status WebSocket connection failed.", event);
	});
	socket.addEventListener("close", () => {
		window.setTimeout(connect, 1000);
	});
}

connect();
