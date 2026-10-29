"use strict";

const trackList = document.getElementById("track-list");
const tracksElement = document.getElementById("tracks");

function render(state) {
	const fragment = document.createDocumentFragment();

	for (const request of state.requests) {
		const added = request.completed;
		const item = document.createElement("li");
		item.className = `track ${added ? "track--added" : "track--not-added"}`;
		const details = document.createElement("div");
		details.className = "track__details";
		const requester = document.createElement("span");
		requester.className = "track__requester";
		const requesterName = request.requesterLogin || request.requestedFor || request.requestedBy || "Unknown requester";
		if (request.requesterAvatarUrl) {
			const avatar = document.createElement("img");
			avatar.className = "track__avatar";
			avatar.src = request.requesterAvatarUrl;
			avatar.alt = "";
			avatar.width = 20;
			avatar.height = 20;
			avatar.referrerPolicy = "no-referrer";
			avatar.addEventListener("error", () => avatar.remove(), { once: true });
			requester.append(avatar);
		} else {
			const fallback = document.createElement("span");
			fallback.className = "track__avatar-fallback";
			fallback.textContent = requesterName.slice(0, 1).toUpperCase();
			requester.append(fallback);
		}
		const username = document.createElement("span");
		username.className = "track__username";
		username.textContent = request.requesterLogin ? `@${request.requesterLogin}` : requesterName;
		username.title = username.textContent;
		requester.append(username);
		details.append(requester);
		const trackName = document.createElement("span");
		trackName.className = "track__name";
		trackName.textContent = request.trackName;
		trackName.title = request.trackName;
		details.append(trackName);
		item.append(details);
		const status = added ? "complete" : "not complete";
		item.setAttribute("aria-label", request.requesterLogin
			? `${request.trackName}, requested by @${request.requesterLogin}: ${status}`
			: `${request.trackName}, requested by ${requesterName}: ${status}`);
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
