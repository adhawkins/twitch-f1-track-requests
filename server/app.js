const account = document.querySelector("#account");
const channelProfile = document.querySelector("#channel-profile");
const channelKicker = document.querySelector("#channel-kicker");
const channelName = document.querySelector("#channel-name");
const streamTitle = document.querySelector("#stream-title");
const channelInfoError = document.querySelector("#channel-info-error");
const form = document.querySelector("#request-form");
const select = document.querySelector("#track-select");
const assignmentControls = document.querySelector("#assignment-controls");
const assignTrackCheckbox = document.querySelector("#assign-track-checkbox");
const assignmentSelectWrapper = document.querySelector("#assignment-select-wrapper");
const recentChatterSelect = document.querySelector("#recent-chatter-select");
const assignmentHelp = document.querySelector("#assignment-help");
const requestButton = document.querySelector("#request-button");
const requestHelp = document.querySelector("#request-help");
const requestsDisabledMessage = document.querySelector("#requests-disabled-message");
const requestList = document.querySelector("#request-list");
const emptyState = document.querySelector("#empty-state");
const queueCount = document.querySelector("#queue-count");
const moderatorTools = document.querySelector("#moderator-tools");
const notice = document.querySelector("#notice");
const verbose = new URLSearchParams(window.location.search).has("verbose");
let state;
let busy = false;
let refreshSequence = 0;

function log(event, details = {}) {
	if (!verbose) return;
	console.info("[track-requests]", new Date().toISOString(), event, details);
}

log("page.loaded", {
	userAgent: navigator.userAgent,
	language: navigator.language,
	online: navigator.onLine,
});

function showNotice(message, isError = false) {
	notice.textContent = message;
	notice.classList.toggle("visible", Boolean(message));
	notice.classList.toggle("success", Boolean(message) && !isError);
}

async function api(path, options = {}) {
	const headers = new Headers(options.headers || {});
	if (options.body) headers.set("Content-Type", "application/json");
	if (state && state.csrfToken && options.method === "POST") {
		headers.set("X-CSRF-Token", state.csrfToken);
	}
	const method = options.method || "GET";
	log("api.request", { method, path });
	let response;
	try {
		response = await fetch(path, { ...options, headers, credentials: "same-origin" });
	} catch (error) {
		log("api.network-error", { method, path, name: error.name, message: error.message });
		throw error;
	}
	let result = {};
	try {
		result = await response.json();
	} catch {
		log("api.invalid-response", { method, path, status: response.status });
		throw new Error("The server returned an unreadable response.");
	}
	log("api.response", { method, path, status: response.status, ok: response.ok });
	if (!response.ok) {
		log("api.rejected", { method, path, status: response.status, error: result.error || "The request failed." });
		throw new Error(result.error || "The request failed.");
	}
	return result;
}

function element(tag, className, text) {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

function countryFlag(countryCode) {
	if (!/^[A-Z]{2}$/.test(countryCode || "")) return "";
	return String.fromCodePoint(...Array.from(countryCode, character => 0x1f1e6 + character.charCodeAt(0) - 65));
}

function renderAccount() {
	account.replaceChildren();
	if (!state.currentUser) {
		const login = element("a", "button button-primary button-small", "Log in with Twitch");
		login.href = "/auth/login?as=viewer";
		account.append(login);
		return;
	}
	if (state.currentUser.profileImageUrl) {
		const avatar = element("img", "account-avatar");
		avatar.src = state.currentUser.profileImageUrl;
		avatar.alt = "";
		avatar.width = 32;
		avatar.height = 32;
		avatar.referrerPolicy = "no-referrer";
		avatar.addEventListener("error", () => avatar.remove(), { once: true });
		account.append(avatar);
	}
	account.append(element("span", "account-name", `@${state.currentUser.login}`));
	const logout = element("button", "text-button", "LOG OUT");
	logout.type = "button";
	logout.addEventListener("click", async () => {
		try {
			await api("/api/logout", { method: "POST" });
			await refresh();
			showNotice("You have been logged out.");
		} catch (error) {
			showNotice(error.message, true);
		}
	});
	account.append(logout);
}

function renderChannel() {
	const channel = state.channelInfo;
	channelName.textContent = channel ? channel.displayName : `#${state.channel}`;
	const previousAvatar = channelProfile.querySelector(".channel-avatar");
	if (previousAvatar) previousAvatar.remove();
	const placeholder = channelProfile.querySelector(".channel-avatar-placeholder");
	if (channel && channel.profileImageUrl) {
		const avatar = element("img", "channel-avatar");
		avatar.src = channel.profileImageUrl;
		avatar.alt = `${channel.displayName} Twitch profile picture`;
		avatar.width = 76;
		avatar.height = 76;
		avatar.referrerPolicy = "no-referrer";
		avatar.addEventListener("error", () => {
			avatar.remove();
			placeholder.hidden = false;
		}, { once: true });
		channelProfile.insertBefore(avatar, channelProfile.querySelector(".channel-details"));
		placeholder.hidden = true;
	} else {
		placeholder.hidden = false;
	}
	channelProfile.classList.toggle("is-live", Boolean(channel && channel.isLive));
	channelKicker.textContent = channel && channel.isLive ? "LIVE NOW" : "TWITCH CHANNEL";
	streamTitle.textContent = channel && channel.isLive ? channel.streamTitle : "";
	channelInfoError.textContent = state.channelInfoError || "";
	channelInfoError.hidden = !state.channelInfoError;
}

function renderTracks() {
	const currentTrack = select.value;
	select.replaceChildren();
	select.append(new Option("Choose a circuit…", ""));
	const requestedTrackIds = new Set(state.requests.map(request => request.trackId));
	const alphabetizedTracks = [...state.tracks].sort((left, right) =>
		left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
	for (const track of alphabetizedTracks) {
		const option = new Option(track.name, track.id);
		option.disabled = requestedTrackIds.has(track.id);
		if (option.disabled) option.textContent += " — requested";
		select.append(option);
	}
	if (currentTrack && !requestedTrackIds.has(currentTrack)) select.value = currentTrack;
}

function renderRecentChatters() {
	const selectedUserId = recentChatterSelect.value;
	const chatters = state.recentChatters || [];
	recentChatterSelect.replaceChildren(new Option(
		chatters.length ? "Choose a recent chatter…" : "No recent chatters available",
		"",
	));
	for (const chatter of chatters) {
		recentChatterSelect.append(new Option(`@${chatter.login} (${chatter.displayName})`, chatter.id));
	}
	if (selectedUserId && chatters.some(chatter => chatter.id === selectedUserId)) {
		recentChatterSelect.value = selectedUserId;
	}
	assignmentControls.hidden = !state.isModerator;
	assignmentSelectWrapper.hidden = !assignTrackCheckbox.checked;
	recentChatterSelect.disabled = !state.isModerator || !assignTrackCheckbox.checked || !chatters.length || busy;
	assignTrackCheckbox.disabled = busy;
	assignmentHelp.textContent = chatters.length
		? "Chatters seen in the last 30 minutes are available. An assigned request uses their one request for this round."
		: "No recent chatters are available yet. Chatters appear here after they speak in Twitch chat.";
}

function renderRequests() {
	requestList.replaceChildren();
	emptyState.hidden = state.requests.length !== 0;
	queueCount.textContent = `${state.requests.length} ${state.requests.length === 1 ? "TRACK" : "TRACKS"}`;
	for (const [index, request] of state.requests.entries()) {
		const item = element("li", "request-item");
		item.append(element("span", "request-number", String(index + 1).padStart(2, "0")));
		const details = element("div", "request-details");
		const trackName = element("div", "track-name");
		if (request.countryCode) {
			const flag = element("span", "track-flag", countryFlag(request.countryCode));
			flag.setAttribute("role", "img");
			flag.setAttribute("aria-label", request.countryCode);
			trackName.append(flag);
		}
		trackName.append(element("span", null, request.trackName));
		details.append(trackName);
		const requester = element("div", "requester");
		if (request.requesterAvatarUrl) {
			const avatar = element("img", "requester-avatar");
			avatar.src = request.requesterAvatarUrl;
			avatar.alt = "";
			avatar.width = 22;
			avatar.height = 22;
			avatar.referrerPolicy = "no-referrer";
			avatar.addEventListener("error", () => {
				const fallback = element("span", "requester-avatar-fallback", (request.requestedFor || request.requestedBy).slice(0, 1).toUpperCase());
				avatar.replaceWith(fallback);
			}, { once: true });
			requester.append(avatar);
		} else {
			requester.append(element("span", "requester-avatar-fallback", (request.requestedFor || request.requestedBy).slice(0, 1).toUpperCase()));
		}
		requester.append(element("span", null, request.requestedFor
			? `Requested by ${request.requestedBy} for ${request.requestedFor}`
			: `Requested by ${request.requestedBy}`));
		details.append(requester);
		item.append(details);

		const status = element("div", "request-status");
		if (request.completed) {
			status.append(element("span", "status-pill completed", "Added"));
		}
		if (state.isStreamer && !request.completed) {
			const complete = element("button", "button button-outline button-small", "Add");
			complete.type = "button";
			complete.addEventListener("click", async () => {
				complete.disabled = true;
				try {
					await api(`/api/requests/${encodeURIComponent(request.id)}/complete`, { method: "POST" });
					await refresh();
					showNotice(`${request.trackName} added to the track list.`);
				} catch (error) {
					showNotice(error.message, true);
					complete.disabled = false;
				}
			});
			status.append(complete);
		}
		item.append(status);
		requestList.append(item);
	}
}

function renderRequestForm() {
	const loggedIn = Boolean(state.currentUser);
	const noMoreTracks = state.requests.length >= state.tracks.length;
	const requestLimitReached = state.alreadyRequested && !state.isModerator;
	const canRequest = loggedIn && state.trackSelectionEnabled && state.requestsEnabled
		&& !requestLimitReached && !noMoreTracks;
	const assignmentNeedsChatter = state.isModerator && assignTrackCheckbox.checked;
	const assignedUserSelected = !assignmentNeedsChatter || Boolean(recentChatterSelect.value);
	const availableOptionCount = [...select.options].filter(option => option.value && !option.disabled).length;
	form.hidden = !state.trackSelectionEnabled;
	requestsDisabledMessage.hidden = state.requestsEnabled;
	select.disabled = !canRequest || busy;
	assignTrackCheckbox.disabled = busy;
	recentChatterSelect.disabled = !state.isModerator || !assignTrackCheckbox.checked || !(state.recentChatters || []).length || busy;
	requestButton.disabled = !canRequest || !assignedUserSelected || busy;
	log("selection.eligibility", {
		loggedIn,
		isModerator: state.isModerator,
		trackSelectionEnabled: state.trackSelectionEnabled,
		requestsEnabled: state.requestsEnabled,
		alreadyRequested: state.alreadyRequested,
		requestLimitReached,
		assignmentNeedsChatter,
		assignedUserSelected,
		requestCount: state.requests.length,
		trackCount: state.tracks.length,
		availableOptionCount,
		noMoreTracks,
		busy,
		selectDisabled: select.disabled,
		requestButtonDisabled: requestButton.disabled,
	});
	if (!state.trackSelectionEnabled) requestHelp.textContent = "Track selection is currently disabled by a moderator.";
	else if (!loggedIn) requestHelp.textContent = "Sign in with Twitch to join the queue.";
	else if (requestLimitReached) requestHelp.textContent = "You have already made a request. A moderator can allow new requests.";
	else if (noMoreTracks) requestHelp.textContent = "Every available circuit has already been requested.";
	else if (state.isModerator) requestHelp.textContent = "As a channel moderator, you can request multiple circuits.";
	else requestHelp.textContent = "Choose any available circuit. You can make one request.";
}

function renderModeratorTools() {
	moderatorTools.replaceChildren();
	if (state.separateChatAccount && (!state.streamerConnected || !state.chatBotGrantReady)) {
		const connect = element(
			"a",
			"button button-outline button-small",
			state.streamerConnected ? "Authorize chat bot" : "Connect channel account",
		);
		connect.href = "/auth/login?as=streamer";
		moderatorTools.append(connect);
	}
	if (!state.chatAuthorizationReady || (state.chatConnectionState === "needs-authorization"
		&& (!state.separateChatAccount || state.chatBotGrantReady))) {
		const connect = element(
			"a",
			"button button-outline button-small",
			state.separateChatAccount
				? `Connect chat account (@${state.chatSenderLogin})`
				: state.streamerConnected ? "Enable chat commands" : "Connect channel account",
		);
		connect.href = state.separateChatAccount ? "/auth/login?as=chat" : "/auth/login?as=streamer";
		moderatorTools.append(connect);
	} else {
		const status = state.chatConnected
			? "Twitch chat connected via EventSub"
			: state.chatConnectionState === "connecting"
				? "Connecting to Twitch chat…"
				: "Twitch chat reconnecting…";
		moderatorTools.append(element("span", "chat-status", status));
	}
	if (state.isModerator) {
		const actions = [
			{
				label: "Reset track list",
				path: "/api/reset/tracks",
				confirm: "Clear all track requests and allow everyone to request again?",
				success: "Track list cleared. Everyone can make a new request.",
			},
			{
				label: "Allow new requests",
				path: "/api/reset/allow-new-requests",
				confirm: "Allow everyone to make a new request? Current track requests will remain in the queue.",
				success: "New requests are allowed.",
			},
			{
				label: state.trackSelectionEnabled ? "Disable track selection" : "Enable track selection",
				className: state.trackSelectionEnabled
					? "button button-danger button-small"
					: "button button-outline button-small",
				path: `/api/moderator/track-selection/${state.trackSelectionEnabled ? "disable" : "enable"}`,
				confirm: state.trackSelectionEnabled
					? "Disable track selection for everyone?"
					: "Enable track selection for everyone?",
				success: state.trackSelectionEnabled
					? "Track selection disabled."
					: "Track selection enabled.",
			},
			{
				label: state.requestsEnabled ? "Disable requests" : "Enable requests",
				className: state.requestsEnabled
					? "button button-danger button-small"
					: "button button-outline button-small",
				path: `/api/moderator/requests/${state.requestsEnabled ? "disable" : "enable"}`,
				confirm: state.requestsEnabled
					? "Disable new requests? The rest of the web interface and current queue will remain visible."
					: "Enable new requests?",
				success: state.requestsEnabled ? "New requests disabled." : "New requests enabled.",
			},
		];
		for (const action of actions) {
			const button = element("button", action.className || "button button-danger button-small", action.label);
			button.type = "button";
			button.addEventListener("click", async () => {
				if (!window.confirm(action.confirm)) {
					log("moderator-action.cancelled", { path: action.path });
					return;
				}
				log("moderator-action.started", { path: action.path });
				button.disabled = true;
				try {
					const result = await api(action.path, { method: "POST" });
					await refresh();
					log("moderator-action.completed", { path: action.path });
					showNotice(typeof action.success === "function" ? action.success(result) : action.success);
				} catch (error) {
					log("moderator-action.failed", { path: action.path, name: error.name, message: error.message });
					showNotice(error.message, true);
					button.disabled = false;
				}
			});
			moderatorTools.append(button);
		}
	}
}

function render() {
	renderChannel();
	renderAccount();
	renderTracks();
	renderRecentChatters();
	renderRequests();
	renderRequestForm();
	renderModeratorTools();
}

async function refresh() {
	const sequence = ++refreshSequence;
	log("state.refresh.started", { sequence });
	const nextState = await api("/api/state");
	const sessionResponse = await api("/api/session");
	if (sequence !== refreshSequence) return;
	state = { ...nextState, csrfToken: sessionResponse.csrfToken };
	log("state.refresh.completed", {
		sequence,
		hasUser: Boolean(state.currentUser),
		isModerator: state.isModerator,
		alreadyRequested: state.alreadyRequested,
		requestCount: state.requests.length,
		trackCount: state.tracks.length,
		streamerConnected: state.streamerConnected,
	});
	render();
}

function connectStateSocket() {
	const url = new URL("/api/events", window.location.href);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	const socket = new WebSocket(url);

	socket.addEventListener("open", () => {
		log("state.websocket.connected");
	});
	socket.addEventListener("message", event => {
		let message;
		try {
			message = JSON.parse(event.data);
		} catch {
			log("state.websocket.invalid-message");
			return;
		}
		if (message.type !== "page-state" || !message.state
			|| !Array.isArray(message.state.tracks) || !Array.isArray(message.state.requests)) {
			return;
		}
		refreshSequence++;
		state = { ...message.state, csrfToken: state?.csrfToken };
		log("state.websocket.updated", {
			requestCount: state.requests.length,
			trackCount: state.tracks.length,
		});
		render();
	});
	socket.addEventListener("error", () => {
		log("state.websocket.error");
	});
	socket.addEventListener("close", () => {
		log("state.websocket.disconnected");
		window.setTimeout(connectStateSocket, 1000);
	});
}

form.addEventListener("submit", async event => {
	event.preventDefault();
	if (!select.value || busy) {
		log("request.submit-ignored", { hasSelection: Boolean(select.value), busy, selectDisabled: select.disabled });
		return;
	}
	const trackId = select.value;
	const assignToUserId = state.isModerator && assignTrackCheckbox.checked ? recentChatterSelect.value : undefined;
	if (state.isModerator && assignTrackCheckbox.checked && !assignToUserId) {
		showNotice("Choose a recent chatter to assign this request to.", true);
		return;
	}
	log("request.submit.started", { trackId, assigned: Boolean(assignToUserId) });
	busy = true;
	renderRequestForm();
	try {
		const body = { trackId };
		if (assignToUserId) body.assignToUserId = assignToUserId;
		await api("/api/requests", {
			method: "POST",
			body: JSON.stringify(body),
		});
		await refresh();
		log("request.submit.completed", { trackId });
		showNotice("Your track is in the queue.");
	} catch (error) {
		log("request.submit.failed", { name: error.name, message: error.message });
		showNotice(error.message, true);
	} finally {
		busy = false;
		renderRequestForm();
	}
});

assignTrackCheckbox.addEventListener("change", () => {
	assignmentSelectWrapper.hidden = !assignTrackCheckbox.checked;
	renderRequestForm();
});
recentChatterSelect.addEventListener("change", renderRequestForm);

refresh().catch(error => {
	log("state.refresh.failed", { name: error.name, message: error.message });
	showNotice(error.message, true);
	requestHelp.textContent = "The request service could not be reached. Refresh to try again.";
}).finally(connectStateSocket);
