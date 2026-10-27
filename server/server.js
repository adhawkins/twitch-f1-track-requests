const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const WebSocket = require("ws");

const config = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
const tracks = [
	{ id: "albert-park", name: "Australia", countryCode: "AU" },
	{ id: "shanghai", name: "China", countryCode: "CN" },
	{ id: "suzuka", name: "Japan", countryCode: "JP" },
	{ id: "bahrain", name: "Bahrain", countryCode: "BH" },
	{ id: "jeddah", name: "Saudi Arabia", countryCode: "SA" },
	{ id: "miami", name: "Miami", countryCode: "US" },
	{ id: "montreal", name: "Canada", countryCode: "CA" },
	{ id: "monaco", name: "Monaco", countryCode: "MC" },
	{ id: "barcelona", name: "Catalunya", countryCode: "ES" },
	{ id: "spielberg", name: "Austria", countryCode: "AT" },
	{ id: "spielberg-reverse", name: "Austria Reverse", countryCode: "AT" },
	{ id: "silverstone", name: "Great Britain", countryCode: "GB" },
	{ id: "silverstone-reverse", name: "Great Britain Reverse", countryCode: "GB" },
	{ id: "spa", name: "Belgium", countryCode: "BE" },
	{ id: "hungaroring", name: "Hungary", countryCode: "HU" },
	{ id: "zandvoort", name: "Netherlands", countryCode: "NL" },
	{ id: "zandvoort-reverse", name: "Netherlands Reverse", countryCode: "NL" },
	{ id: "monza", name: "Monza", countryCode: "IT" },
	{ id: "madrid", name: "Madrid", countryCode: "ES" },
	{ id: "baku", name: "Azerbaijan", countryCode: "AZ" },
	{ id: "singapore", name: "Singapore", countryCode: "SG" },
	{ id: "austin", name: "Texas", countryCode: "US" },
	{ id: "mexico-city", name: "Mexico", countryCode: "MX" },
	{ id: "interlagos", name: "Brazil", countryCode: "BR" },
	{ id: "las-vegas", name: "Las Vegas", countryCode: "US" },
	{ id: "lusail", name: "Qatar", countryCode: "QA" },
	{ id: "yas-marina", name: "Abu Dhabi", countryCode: "AE" },
	{ id: "imola", name: "Imola", countryCode: "IT" },
];
const verbose = process.argv.includes("--verbose");
const clientId = config.twitch && config.twitch.clientId;
const clientSecret = config.twitch && config.twitch.clientSecret;
const baseUrl = config.baseUrl;
let redirectUri;
const chatScopes = ["user:read:chat", "user:write:chat"];
const whisperScopes = ["user:manage:whispers"];
const chatBotScopes = ["user:bot"];
const channelBotScopes = ["channel:bot"];
const streamerAuthFile = path.join(__dirname, ".track-request-auth.json");
const sessionLifetime = 12 * 60 * 60 * 1000;
const csrfHeader = "x-csrf-token";
const sessions = new Map();
const pendingLogins = new Map();
const requests = [];
const requestedUsers = new Set();
const recentChatters = new Map();
let trackSelectionEnabled = true;
let requestsEnabled = true;
let apiWebSocketServer;
const apiWebSocketRequests = new WeakMap();
let stateRevision = 0;

function getApiConfigurationState() {
	return {
		type: "state",
		trackSelectionEnabled,
		requestsEnabled,
	};
}

async function sendApiPageState(socket, request, revision) {
	try {
		const state = await getState(request);
		if (revision !== stateRevision || socket.readyState !== WebSocket.OPEN) return;
		socket.send(JSON.stringify({ type: "page-state", state }), error => {
			if (error) log("http-api.websocket.send-error", { message: error.message });
		});
	} catch (error) {
		log("http-api.websocket.state-error", { message: error.message });
	}
}

function broadcastApiConfigurationState() {
	if (!apiWebSocketServer) return;
	const revision = ++stateRevision;
	const message = JSON.stringify(getApiConfigurationState());
	for (const client of apiWebSocketServer.clients) {
		if (client.readyState === WebSocket.OPEN) {
			client.send(message, error => {
				if (error) log("http-api.websocket.send-error", { message: error.message });
			});
			const request = apiWebSocketRequests.get(client);
			if (request) void sendApiPageState(client, request, revision);
		}
	}
}

function sendApiWebSocketError(socket, commandId, status, message) {
	socket.send(JSON.stringify({
		type: "result",
		commandId,
		ok: false,
		status,
		error: message,
	}));
}

function getHttpApiWebSocketAuthError(token) {
	const configuredToken = config.httpApi && config.httpApi.token;
	if (typeof configuredToken !== "string" || configuredToken.length < 32
		|| configuredToken.startsWith("replace-with-")) {
		return { status: 503, message: "The HTTP API is not configured." };
	}
	if (typeof token !== "string" || !token.trim()) {
		return { status: 401, message: "HTTP API authentication is required for commands." };
	}
	const provided = Buffer.from(token);
	const expected = Buffer.from(configuredToken);
	if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
		return { status: 401, message: "The HTTP API token is invalid." };
	}
	return undefined;
}

function handleApiWebSocketCommand(socket, data, isBinary) {
	let message;
	try {
		if (isBinary) throw new HttpError(400, "WebSocket commands must be JSON text.");
		message = JSON.parse(data.toString());
	} catch (error) {
		const status = error instanceof HttpError ? error.status : 400;
		const text = error instanceof HttpError ? error.message : "The WebSocket command is not valid JSON.";
		sendApiWebSocketError(socket, undefined, status, text);
		return;
	}

	const commandId = message && typeof message.commandId === "string"
		&& message.commandId.length <= 128 ? message.commandId : undefined;
	if (!commandId || message.type !== "command" || typeof message.action !== "string") {
		sendApiWebSocketError(socket, commandId, 400, "The WebSocket command is invalid.");
		return;
	}
	const authError = getHttpApiWebSocketAuthError(message.token);
	if (authError) {
		sendApiWebSocketError(socket, commandId, authError.status, authError.message);
		return;
	}

	try {
		let result = { ok: true };
		switch (message.action) {
			case "reset-tracks":
				resetTrackList();
				break;
			case "allow-new-requests":
				allowNewRequests();
				break;
			case "disable-track-selection":
				setTrackSelectionEnabled(false);
				result.trackSelectionEnabled = trackSelectionEnabled;
				break;
			case "enable-track-selection":
				setTrackSelectionEnabled(true);
				result.trackSelectionEnabled = trackSelectionEnabled;
				break;
			case "disable-requests":
				setRequestsEnabled(false);
				result.requestsEnabled = requestsEnabled;
				break;
			case "enable-requests":
				setRequestsEnabled(true);
				result.requestsEnabled = requestsEnabled;
				break;
			case "complete-next": {
				const item = requests.find(entry => !entry.completed);
				if (!item) throw new HttpError(409, "There are no pending track requests to complete.");
				completeRequest(item.id);
				result.requestId = item.id;
				result.trackName = item.trackName;
				break;
			}
			case "complete-request": {
				if (typeof message.requestId !== "string" || !/^[0-9a-f-]{36}$/i.test(message.requestId)) {
					throw new HttpError(400, "A valid request ID is required.");
				}
				const item = completeRequest(message.requestId);
				result.requestId = item.id;
				result.trackName = item.trackName;
				break;
			}
			default:
				throw new HttpError(400, "Unknown HTTP API command.");
		}
		socket.send(JSON.stringify({ type: "result", commandId, ...result }));
	} catch (error) {
		if (error instanceof HttpError) {
			sendApiWebSocketError(socket, commandId, error.status, error.message);
			return;
		}
		log("http-api.websocket.command-error", { commandId, message: error.message });
		console.error("WebSocket API command failed:", error);
		sendApiWebSocketError(socket, commandId, 500, "An unexpected server error occurred.");
	}
}

const twitchUserProfileImages = new Map();
const twitchUserProfileImagePromises = new Map();
const trackIds = new Set();
let streamerAuthorization;
let streamerRefreshPromise;
let chatAuthorization;
let chatRefreshPromise;
let twitchAppAuthorization;
let channelInfoCache;
let channelInfoPromise;
let eventSubSocket;
let chatConnected = false;
let chatConnectionState = "disconnected";
let chatReconnectTimer;
let chatSendQueue = [];
let chatSendTimer;
let chatSendInProgress = false;
let eventSubReconnectUrl;
let whisperSendQueue = Promise.resolve();
let lastWhisperSentAt = 0;

function log(event, details = {}) {
	if (!verbose) return;
	console.info("[track-requests]", JSON.stringify({ timestamp: new Date().toISOString(), event, ...details }));
}

class HttpError extends Error {
	constructor(status, message, upstreamStatus) {
		super(message);
		this.status = status;
		this.upstreamStatus = upstreamStatus;
	}
}

function validateConfig() {
	if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
		throw new Error("Set port in track-requests/config.json to a port between 1 and 65535.");
	}
	if (typeof config.channel !== "string" || !/^[a-zA-Z0-9_]{1,25}$/.test(config.channel)
		|| config.channel.toLowerCase() === "your_twitch_channel") {
		throw new Error("Set config.channel to the Twitch channel login in track-requests/config.json.");
	}
	let pageUrl;
	try {
		pageUrl = new URL(baseUrl);
	} catch {
		throw new Error("Set config.baseUrl to the public HTTPS URL of the track requests page.");
	}
	if (pageUrl.protocol !== "https:" || pageUrl.username || pageUrl.password
		|| pageUrl.search || pageUrl.hash) {
		throw new Error("config.baseUrl must be a public HTTPS URL with no credentials, query, or fragment.");
	}
	redirectUri = new URL("/auth/callback", pageUrl).toString();
	if (config.chatUser !== undefined && (typeof config.chatUser !== "string"
		|| (config.chatUser.trim() && !/^[a-zA-Z0-9_]{1,25}$/.test(config.chatUser.trim())))) {
		throw new Error("Set config.chatUser to a Twitch login, or leave it empty to use the channel account.");
	}
	for (const track of tracks) {
		if (!track || typeof track.id !== "string" || !/^[a-z0-9-]{1,64}$/.test(track.id)
			|| typeof track.name !== "string" || track.name.trim().length === 0) {
			throw new Error("Each track needs a lowercase id and a non-empty name.");
		}
		if (trackIds.has(track.id)) {
			throw new Error(`Duplicate track id in server.js: ${track.id}`);
		}
		trackIds.add(track.id);
	}
	if (typeof clientId !== "string" || !clientId.trim() || clientId === "your_twitch_client_id"
		|| typeof clientSecret !== "string" || !clientSecret.trim()
		|| clientSecret === "your_twitch_client_secret") {
		throw new Error("Set twitch.clientId and twitch.clientSecret in track-requests/config.json.");
	}
}

function randomToken() {
	return crypto.randomBytes(32).toString("base64url");
}

function configuredChatUser() {
	return (config.chatUser || "").trim().toLowerCase();
}

function chatUserLogin() {
	return configuredChatUser() || config.channel.toLowerCase();
}

function usesSeparateChatAccount() {
	return Boolean(configuredChatUser() && configuredChatUser() !== config.channel.toLowerCase());
}

function getStreamerScopes() {
	return usesSeparateChatAccount()
		? ["moderation:read", ...channelBotScopes]
		: ["moderation:read", ...chatScopes, ...whisperScopes];
}

function getChatScopes() {
	return usesSeparateChatAccount()
		? [...chatScopes, ...chatBotScopes, ...whisperScopes]
		: [...chatScopes, ...whisperScopes];
}

function persistAuthorizations(broadcaster, chat) {
	const storedAuthorization = {
		version: 1,
		channel: config.channel.toLowerCase(),
		broadcaster: broadcaster ? {
			broadcasterId: broadcaster.broadcasterId,
			accessToken: broadcaster.accessToken,
			refreshToken: broadcaster.refreshToken,
			expiresAt: broadcaster.expiresAt,
			scopes: broadcaster.scopes,
		} : null,
		chatUser: configuredChatUser(),
		chatAuthorization: chat ? {
			userId: chat.userId,
			login: chat.login,
			accessToken: chat.accessToken,
			refreshToken: chat.refreshToken,
			expiresAt: chat.expiresAt,
			scopes: chat.scopes,
		} : null,
	};
	const temporaryFile = `${streamerAuthFile}.${process.pid}.${randomToken()}.tmp`;
	try {
		fs.writeFileSync(temporaryFile, `${JSON.stringify(storedAuthorization, null, 2)}\n`, {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
		});
		fs.chmodSync(temporaryFile, 0o600);
		fs.renameSync(temporaryFile, streamerAuthFile);
	} catch (error) {
		try {
			fs.unlinkSync(temporaryFile);
		} catch (cleanupError) {
			if (cleanupError.code !== "ENOENT") {
				log("streamer.authorization.cleanup_error", { message: cleanupError.message });
			}
		}
		throw new Error(`Could not securely save the Twitch authorization: ${error.message}`);
	}
}

function loadAuthorizations() {
	let contents;
	try {
		contents = fs.readFileSync(streamerAuthFile, "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return {};
		throw new Error(`Could not read ${path.basename(streamerAuthFile)}: ${error.message}`);
	}
	try {
		fs.chmodSync(streamerAuthFile, 0o600);
	} catch (error) {
		throw new Error(`Could not restrict access to ${path.basename(streamerAuthFile)}: ${error.message}`);
	}

	let storedAuthorization;
	try {
		storedAuthorization = JSON.parse(contents);
	} catch {
		throw new Error(`${path.basename(streamerAuthFile)} is not valid JSON. Fix or remove it and reconnect the Twitch accounts.`);
	}
	if (!storedAuthorization || storedAuthorization.version !== 1
		|| typeof storedAuthorization.channel !== "string") {
		throw new Error(`${path.basename(streamerAuthFile)} has an invalid authorization state. Remove it and reconnect the Twitch accounts.`);
	}
	if (storedAuthorization.channel.toLowerCase() !== config.channel.toLowerCase()) {
		log("streamer.authorization.channel_mismatch", { configuredChannel: config.channel });
		return {};
	}

	const isValidRecord = (record, requiredScopes) => record
		&& typeof record.accessToken === "string"
		&& typeof record.refreshToken === "string"
		&& Number.isFinite(record.expiresAt)
		&& Array.isArray(record.scopes)
		&& requiredScopes.every(scope => record.scopes.includes(scope));
	const storedBroadcaster = storedAuthorization.broadcaster
		|| (typeof storedAuthorization.broadcasterId === "string" ? storedAuthorization : undefined);
	if (storedBroadcaster && (!isValidRecord(storedBroadcaster, ["moderation:read"])
		|| typeof storedBroadcaster.broadcasterId !== "string")) {
		throw new Error(`${path.basename(streamerAuthFile)} has an invalid broadcaster authorization. Remove it and reconnect the channel account.`);
	}
	const storedChat = storedAuthorization.chatAuthorization;
	if (storedChat && (!isValidRecord(storedChat, [])
		|| typeof storedChat.userId !== "string"
		|| typeof storedChat.login !== "string")) {
		throw new Error(`${path.basename(streamerAuthFile)} has an invalid chat authorization. Remove it and reconnect the chat account.`);
	}
	const broadcaster = storedBroadcaster ? {
		broadcasterId: storedBroadcaster.broadcasterId,
		accessToken: storedBroadcaster.accessToken,
		refreshToken: storedBroadcaster.refreshToken,
		expiresAt: storedBroadcaster.expiresAt,
		scopes: storedBroadcaster.scopes,
	} : undefined;
	const chat = storedChat && usesSeparateChatAccount()
		&& storedChat.login.toLowerCase() === configuredChatUser() ? {
			userId: storedChat.userId,
			login: storedChat.login.toLowerCase(),
			accessToken: storedChat.accessToken,
			refreshToken: storedChat.refreshToken,
			expiresAt: storedChat.expiresAt,
			scopes: storedChat.scopes,
		} : undefined;
	if (storedChat && !chat) {
		log("chat.authorization.user_mismatch", { configuredUser: configuredChatUser() || null });
	}
	return { broadcaster, chat };
}

function sendJson(response, status, value) {
	response.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
	});
	response.end(JSON.stringify(value));
}

function sendText(response, status, text) {
	response.writeHead(status, {
		"Content-Type": "text/plain; charset=utf-8",
		"Cache-Control": "no-store",
	});
	response.end(text);
}

function getCookies(request) {
	const cookies = {};
	for (const entry of (request.headers.cookie || "").split(";")) {
		const separator = entry.indexOf("=");
		if (separator !== -1) {
			cookies[entry.slice(0, separator).trim()] = decodeURIComponent(entry.slice(separator + 1).trim());
		}
	}
	return cookies;
}

function getSession(request) {
	const sessionId = getCookies(request).track_session;
	const session = sessionId && sessions.get(sessionId);
	if (!session) return undefined;
	if (session.expiresAt <= Date.now()) {
		sessions.delete(sessionId);
		return undefined;
	}
	session.expiresAt = Date.now() + sessionLifetime;
	return session;
}

function createSession(user) {
	for (const [id, session] of sessions) {
		if (session.expiresAt <= Date.now()) sessions.delete(id);
	}
	const sessionId = randomToken();
	const session = { user, csrfToken: randomToken(), expiresAt: Date.now() + sessionLifetime };
	sessions.set(sessionId, session);
	return { sessionId, session };
}

function setSessionCookie(request, response, sessionId) {
	const cookie = [
		`track_session=${encodeURIComponent(sessionId)}`,
		"Path=/",
		"HttpOnly",
		"SameSite=Lax",
		"Secure",
		`Max-Age=${Math.floor(sessionLifetime / 1000)}`,
	].join("; ");
	const current = response.getHeader("Set-Cookie");
	response.setHeader("Set-Cookie", [...(Array.isArray(current) ? current : current ? [current] : []), cookie]);
}

function setOAuthStateCookie(request, response, state, clear = false) {
	const cookie = [
		`oauth_state=${clear ? "" : encodeURIComponent(state)}`,
		"Path=/auth/callback",
		"HttpOnly",
		"SameSite=Lax",
		"Secure",
		`Max-Age=${clear ? 0 : 600}`,
	].join("; ");
	const current = response.getHeader("Set-Cookie");
	response.setHeader("Set-Cookie", [...(Array.isArray(current) ? current : current ? [current] : []), cookie]);
}

function requireSession(request) {
	const session = getSession(request);
	if (!session) throw new HttpError(401, "Log in with Twitch to continue.");
	return session;
}

function requireSameOrigin(request) {
	const origin = request.headers.origin;
	if (!origin) throw new HttpError(403, "A same-origin request is required.");
	let originHost;
	try {
		originHost = new URL(origin).host;
	} catch {
		throw new HttpError(403, "The request origin is invalid.");
	}
	if (originHost !== request.headers.host) {
		throw new HttpError(403, "Cross-origin requests are not allowed.");
	}
}

function requireCsrf(request, session) {
	requireSameOrigin(request);
	const provided = Buffer.from(request.headers[csrfHeader] || "");
	const expected = Buffer.from(session.csrfToken);
	if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
		throw new HttpError(403, "The request security token is invalid. Refresh the page and try again.");
	}
}

function requireHttpApiToken(request) {
	const configuredToken = config.httpApi && config.httpApi.token;
	if (typeof configuredToken !== "string" || configuredToken.length < 32
		|| configuredToken.startsWith("replace-with-")) {
		throw new HttpError(503, "Configure a random httpApi.token in config.json to enable the HTTP API.");
	}
	const match = String(request.headers.authorization || "").match(/^Bearer ([^\s]+)$/i);
	if (!match) throw new HttpError(401, "Send the HTTP API token in the Authorization: Bearer header.");
	const provided = Buffer.from(match[1]);
	const expected = Buffer.from(configuredToken);
	if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
		throw new HttpError(401, "The HTTP API token is invalid.");
	}
}

function resetTrackList() {
	const previousRequestCount = requests.length;
	const previousLimitCount = requestedUsers.size;
	requests.length = 0;
	requestedUsers.clear();
	broadcastApiConfigurationState();
	log("track-list.reset", { previousRequestCount, previousLimitCount });
	queueChatMessage("The track list has been cleared.");
}

function allowNewRequests() {
	const previousLimitCount = requestedUsers.size;
	requestedUsers.clear();
	broadcastApiConfigurationState();
	log("requests.reopened", { previousLimitCount, requestedTrackCount: requests.length });
	queueChatMessage("New track requests are now allowed.");
}

function setTrackSelectionEnabled(enabled) {
	const changed = trackSelectionEnabled !== enabled;
	trackSelectionEnabled = enabled;
	if (changed) broadcastApiConfigurationState();
	log("track-selection.updated", { enabled });
	queueChatMessage(enabled
		? "Track selection is now enabled."
		: "Track selection is now disabled.");
}

function setRequestsEnabled(enabled) {
	const changed = requestsEnabled !== enabled;
	requestsEnabled = enabled;
	if (changed) broadcastApiConfigurationState();
	log("requests.updated", { enabled });
	queueChatMessage(enabled
		? "New track requests are now enabled."
		: "New track requests are now disabled.");
}

function completeRequest(requestId) {
	const item = requests.find(entry => entry.id === requestId);
	if (!item) throw new HttpError(404, "That track request no longer exists.");
	if (!item.completed) {
		item.completed = true;
		item.completedAt = new Date().toISOString();
		broadcastApiConfigurationState();
	}
	return item;
}

async function readJson(request) {
	if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
		throw new HttpError(415, "Send a JSON request body.");
	}
	const chunks = [];
	let size = 0;
	for await (const chunk of request) {
		size += chunk.length;
		if (size > 4096) throw new HttpError(413, "The request body is too large.");
		chunks.push(chunk);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new HttpError(400, "The request body is not valid JSON.");
	}
}

async function twitchFetch(url, options = {}) {
	let response;
	try {
		response = await fetch(url, { ...options, signal: AbortSignal.timeout(10000) });
	} catch (error) {
		throw new HttpError(502, `Could not reach Twitch: ${error.message}`);
	}
	const payload = await response.json().catch(() => ({}));
	if (!response.ok) {
		const reason = payload.message || payload.error_description || payload.error || "Twitch rejected the request.";
		throw new HttpError(502, reason, response.status);
	}
	return payload;
}

async function exchangeCode(code) {
	const body = new URLSearchParams({
		client_id: clientId,
		client_secret: clientSecret,
		code,
		grant_type: "authorization_code",
		redirect_uri: redirectUri,
	});
	return twitchFetch("https://id.twitch.tv/oauth2/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body,
	});
}

async function getTwitchUser(accessToken) {
	const result = await twitchFetch("https://api.twitch.tv/helix/users", {
		headers: { Authorization: `Bearer ${accessToken}`, "Client-Id": clientId },
	});
	if (!result.data || result.data.length !== 1) {
		throw new HttpError(502, "Twitch did not return the authenticated account.");
	}
	return result.data[0];
}

async function getTwitchAppAccessToken() {
	if (twitchAppAuthorization && twitchAppAuthorization.expiresAt > Date.now() + 60 * 1000) {
		return twitchAppAuthorization.accessToken;
	}
	const body = new URLSearchParams({
		client_id: clientId,
		client_secret: clientSecret,
		grant_type: "client_credentials",
	});
	const token = await twitchFetch("https://id.twitch.tv/oauth2/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body,
	});
	if (!token.access_token || !token.expires_in) {
		throw new HttpError(502, "Twitch did not return a valid public API access token.");
	}
	twitchAppAuthorization = {
		accessToken: token.access_token,
		expiresAt: Date.now() + token.expires_in * 1000,
	};
	return twitchAppAuthorization.accessToken;
}

async function getTwitchProfileImageUrl(userId) {
	if (twitchUserProfileImages.has(userId)) return twitchUserProfileImages.get(userId);
	if (twitchUserProfileImagePromises.has(userId)) return twitchUserProfileImagePromises.get(userId);
	const profilePromise = (async () => {
		const accessToken = await getTwitchAppAccessToken();
		const parameters = new URLSearchParams({ id: userId });
		const result = await twitchFetch(`https://api.twitch.tv/helix/users?${parameters}`, {
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"Client-Id": clientId,
			},
		});
		if (!result.data || result.data.length !== 1) {
			throw new HttpError(502, "Twitch did not return the requested chatter profile.");
		}
		const profileImageUrl = result.data[0].profile_image_url || null;
		twitchUserProfileImages.set(userId, profileImageUrl);
		return profileImageUrl;
	})();
	twitchUserProfileImagePromises.set(userId, profilePromise);
	try {
		return await profilePromise;
	} finally {
		twitchUserProfileImagePromises.delete(userId);
	}
}

async function getRequestAvatar(userId, source) {
	try {
		return await getTwitchProfileImageUrl(userId);
	} catch (error) {
		log("request.avatar.unavailable", { userId, source, message: error.message });
		return null;
	}
}

async function fetchChannelInfo() {
	const accessToken = await getTwitchAppAccessToken();
	const headers = { Authorization: `Bearer ${accessToken}`, "Client-Id": clientId };
	const userParameters = new URLSearchParams({ login: config.channel.toLowerCase() });
	const userResult = await twitchFetch(`https://api.twitch.tv/helix/users?${userParameters}`, { headers });
	if (!userResult.data || userResult.data.length !== 1) {
		throw new HttpError(502, `Twitch could not find the configured channel ${config.channel}.`);
	}
	const user = userResult.data[0];
	const streamParameters = new URLSearchParams({ user_id: user.id });
	const streamResult = await twitchFetch(`https://api.twitch.tv/helix/streams?${streamParameters}`, { headers });
	const stream = streamResult.data && streamResult.data.find(item => item.type === "live");
	return {
		displayName: user.display_name || user.login,
		profileImageUrl: user.profile_image_url || null,
		isLive: Boolean(stream),
		streamTitle: stream ? stream.title : null,
	};
}

async function getChannelInfo() {
	if (channelInfoCache && channelInfoCache.expiresAt > Date.now()) {
		return { info: channelInfoCache.info, error: null };
	}
	if (!channelInfoPromise) {
		channelInfoPromise = fetchChannelInfo()
			.then(info => {
				channelInfoCache = { info, expiresAt: Date.now() + 30 * 1000 };
				return info;
			})
			.finally(() => {
				channelInfoPromise = undefined;
			});
	}
	try {
		return { info: await channelInfoPromise, error: null };
	} catch (error) {
		log("channel.info.unavailable", { message: error.message });
		return {
			info: channelInfoCache ? channelInfoCache.info : null,
			error: "Channel profile and live status are temporarily unavailable.",
		};
	}
}

function getChatAuthorization() {
	return usesSeparateChatAccount() ? chatAuthorization : streamerAuthorization;
}

function hasChatScopes() {
	const authorization = getChatAuthorization();
	return Boolean(authorization && getChatScopes().every(scope => authorization.scopes.includes(scope)));
}

function hasChannelBotScope() {
	return Boolean(streamerAuthorization
		&& channelBotScopes.every(scope => streamerAuthorization.scopes.includes(scope)));
}

function queueChatMessage(message) {
	const safeMessage = String(message).replace(/[\r\n]/g, " ").slice(0, 450);
	if (!safeMessage || chatSendQueue.length >= 20) {
		log("chat.reply.dropped", { reason: safeMessage ? "queue-full" : "empty" });
		return;
	}
	chatSendQueue.push(safeMessage);
	sendNextChatMessage();
}

async function sendChatWhisper(recipientId, message) {
	const authorization = getChatAuthorization();
	const senderId = authorization && (authorization.userId || authorization.broadcasterId);
	const hasWhisperScope = Boolean(authorization && authorization.scopes
		&& authorization.scopes.includes("user:manage:whispers"));
	log("chat.command_help.whisper.started", {
		senderId: senderId || null,
		recipientId,
		hasWhisperScope,
		chatConnected,
		chatConnectionState,
	});
	if (!senderId) {
		throw new HttpError(503, "The chat account has not been connected.");
	}
	if (!hasWhisperScope) {
		throw new HttpError(503, "The chat account must be reconnected with the user:manage:whispers scope.");
	}
	const accessToken = await getChatAccessToken();
	const parameters = new URLSearchParams({
		from_user_id: senderId,
		to_user_id: recipientId,
	});
	await twitchFetch(`https://api.twitch.tv/helix/whispers?${parameters}`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Client-Id": clientId,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ message }),
	});
	log("chat.command_help.whisper.api_accepted", { senderId, recipientId });
}

function queueChatWhisper(recipientId, message) {
	const sendPromise = whisperSendQueue.then(async () => {
		const waitMs = Math.max(0, 400 - (Date.now() - lastWhisperSentAt));
		if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
		try {
			return await sendChatWhisper(recipientId, message);
		} finally {
			lastWhisperSentAt = Date.now();
		}
	});
	whisperSendQueue = sendPromise.catch(() => {});
	return sendPromise;
}

function queueTrackList(displayName) {
	const messages = [];
	const prefixes = [`@${displayName}, tracks: `, "Tracks (cont.): "];
	let prefix = prefixes[0];
	let current = prefix;
	for (const track of tracks) {
		const name = track.name.replace(/[\r\n]/g, " ").slice(0, 400);
		const separator = current === prefix ? "" : ", ";
		if (current.length + separator.length + name.length > 450 && current !== prefix) {
			messages.push(current);
			prefix = prefixes[1];
			current = prefix;
		}
		const nextSeparator = current === prefix ? "" : ", ";
		current += `${nextSeparator}${name}`;
	}
	if (current !== prefix) messages.push(current);
	for (const message of messages) queueChatMessage(message);
}

function recordRecentChatter(tags, username) {
	const userId = tags["user-id"];
	if (!userId) return;
	const now = Date.now();
	for (const [id, chatter] of recentChatters) {
		if (now - chatter.lastSeenAt > 30 * 60 * 1000) recentChatters.delete(id);
	}
	recentChatters.delete(userId);
	recentChatters.set(userId, {
		id: userId,
		login: username.toLowerCase(),
		displayName: tags["display-name"] || username,
		lastSeenAt: now,
	});
	while (recentChatters.size > 100) {
		recentChatters.delete(recentChatters.keys().next().value);
	}
}

function getRecentChatters() {
	const now = Date.now();
	for (const [id, chatter] of recentChatters) {
		if (now - chatter.lastSeenAt > 30 * 60 * 1000) recentChatters.delete(id);
	}
	return [...recentChatters.values()]
		.sort((left, right) => right.lastSeenAt - left.lastSeenAt)
		.map(({ id, login, displayName }) => ({ id, login, displayName }));
}

function findRecentChatter(username) {
	const normalized = username.replace(/^@/, "").toLowerCase();
	return getRecentChatters().find(chatter => chatter.login === normalized);
}

function sendNextChatMessage() {
	if (!chatConnected || chatSendTimer || chatSendInProgress || !chatSendQueue.length) return;
	const message = chatSendQueue.shift();
	chatSendInProgress = true;
	void (async () => {
		try {
			const authorization = getChatAuthorization();
			const senderId = authorization && (authorization.userId || authorization.broadcasterId);
			if (!streamerAuthorization || !senderId) {
				throw new HttpError(503, "The channel and chat accounts must be connected before sending chat messages.");
			}
			const accessToken = await getChatAccessToken();
			const result = await twitchFetch("https://api.twitch.tv/helix/chat/messages", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${accessToken}`,
					"Client-Id": clientId,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					broadcaster_id: streamerAuthorization.broadcasterId,
					sender_id: senderId,
					message,
				}),
			});
			const sentMessage = result.data && result.data[0];
			if (!sentMessage || !sentMessage.is_sent) {
				log("chat.reply.rejected", {
					reason: sentMessage && sentMessage.drop_reason
						? sentMessage.drop_reason.message
						: "Twitch did not confirm that the message was sent.",
				});
			}
		} catch (error) {
			log("chat.reply.error", { message: error.message });
		} finally {
			chatSendInProgress = false;
			if (chatSendQueue.length) {
				chatSendTimer = setTimeout(() => {
					chatSendTimer = undefined;
					sendNextChatMessage();
				}, 1200);
				chatSendTimer.unref();
			}
		}
	})();
}

function normalizeTrackName(value) {
	return String(value)
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "");
}

function editDistance(left, right) {
	const matrix = Array.from({ length: left.length + 1 }, () => Array(right.length + 1).fill(0));
	for (let leftIndex = 0; leftIndex <= left.length; leftIndex += 1) {
		matrix[leftIndex][0] = leftIndex;
	}
	for (let rightIndex = 0; rightIndex <= right.length; rightIndex += 1) {
		matrix[0][rightIndex] = rightIndex;
	}
	for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
		for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
			const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
			matrix[leftIndex][rightIndex] = Math.min(
				matrix[leftIndex - 1][rightIndex] + 1,
				matrix[leftIndex][rightIndex - 1] + 1,
				matrix[leftIndex - 1][rightIndex - 1] + substitutionCost,
			);
			if (leftIndex > 1 && rightIndex > 1
				&& left[leftIndex - 1] === right[rightIndex - 2]
				&& left[leftIndex - 2] === right[rightIndex - 1]) {
				matrix[leftIndex][rightIndex] = Math.min(
					matrix[leftIndex][rightIndex],
					matrix[leftIndex - 2][rightIndex - 2] + 1,
				);
			}
		}
	}
	return matrix[left.length][right.length];
}

function resolveRequestedTrack(trackName) {
	const normalized = normalizeTrackName(trackName);
	const aliases = new Map([
		["melbourne", "albert-park"],
		["albert park", "albert-park"],
		["shanghai", "shanghai"],
		["suzuka", "suzuka"],
		["jeddah", "jeddah"],
		["montreal", "montreal"],
		["gilles villeneuve", "montreal"],
		["barcelona", "barcelona"],
		["circuit de barcelona catalunya", "barcelona"],
		["spielberg", "spielberg"],
		["red bull ring", "spielberg"],
		["spielberg reverse", "spielberg-reverse"],
		["red bull ring reverse", "spielberg-reverse"],
		["silverstone", "silverstone"],
		["silverstone circuit", "silverstone"],
		["silverstone reverse", "silverstone-reverse"],
		["spa", "spa"],
		["spa francorchamps", "spa"],
		["zandvoort", "zandvoort"],
		["zandvoort reverse", "zandvoort-reverse"],
		["imola", "imola"],
		["madring", "madrid"],
		["baku", "baku"],
		["marina bay", "singapore"],
		["marina bay street circuit", "singapore"],
		["singaporte", "singapore"],
		["cota", "austin"],
		["circuit of the americas", "austin"],
		["austin", "austin"],
		["mexico city", "mexico-city"],
		["hermanos rodriguez", "mexico-city"],
		["interlagos", "interlagos"],
		["sao paulo", "interlagos"],
		["vegas", "las-vegas"],
		["lusail", "lusail"],
		["yas marina", "yas-marina"],
	].map(([alias, id]) => [normalizeTrackName(alias), id]));
	const aliasId = aliases.get(normalized);
	if (aliasId) return tracks.find(track => track.id === aliasId);
	const exactMatch = tracks.find(track => normalizeTrackName(track.name) === normalized);
	if (exactMatch) return exactMatch;

	const candidates = tracks
		.map(track => ({ track, distance: editDistance(normalized, normalizeTrackName(track.name)) }))
		.sort((left, right) => left.distance - right.distance);
	if (!candidates.length) return undefined;
	const candidateName = normalizeTrackName(candidates[0].track.name);
	const threshold = Math.max(1, Math.min(3, Math.floor(Math.max(normalized.length, candidateName.length) * 0.2)));
	if (candidates[0].distance > threshold) return undefined;
	if (candidates[1] && candidates[1].distance === candidates[0].distance) return undefined;
	return candidates[0].track;
}

function createTrackRequest(actor, track, moderator, source = "chat", assignedUser) {
	const requester = assignedUser || actor;
	if (!trackSelectionEnabled) {
		log("request.rejected", { reason: "track-selection-disabled", trackId: track.id, source });
		throw new HttpError(409, "Track selection is currently disabled.");
	}
	if (!requestsEnabled) {
		log("request.rejected", { reason: "requests-disabled", trackId: track.id, source });
		throw new HttpError(409, "New track requests are currently disabled.");
	}
	if ((assignedUser || !moderator) && requestedUsers.has(requester.id)) {
		log("request.rejected", { reason: "viewer-limit", trackId: track.id, source, assigned: Boolean(assignedUser) });
		throw new HttpError(409, assignedUser
			? `${requester.displayName} has already requested a track.`
			: "You have already requested a track.");
	}
	if (requests.some(item => item.trackId === track.id)) {
		log("request.rejected", { reason: "track-unavailable", trackId: track.id, source });
		throw new HttpError(409, "That track has already been requested.");
	}
	requests.push({
		id: crypto.randomUUID(),
		trackId: track.id,
		trackName: track.name,
		countryCode: track.countryCode,
		userId: requester.id,
		requestedBy: assignedUser ? actor.displayName : requester.displayName,
		requestedFor: assignedUser ? requester.displayName : null,
		requesterAvatarUrl: requester.profileImageUrl || null,
		completed: false,
		createdAt: new Date().toISOString(),
	});
	requestedUsers.add(requester.id);
	broadcastApiConfigurationState();
	log("request.accepted", {
		trackId: track.id,
		moderator,
		assigned: Boolean(assignedUser),
		source,
		requestCount: requests.length,
		requestedUserCount: requestedUsers.size,
	});
	if (source === "web") {
		queueChatMessage(assignedUser
			? `${track.name} was requested by ${actor.displayName} for ${requester.displayName}.`
			: `${track.name} was requested by ${requester.displayName}.`);
	}
}

async function handleChatMessage(tags, username, message) {
	const chatDisplayName = tags["display-name"] || username;
	const moderatorCommand = message.match(/^!(tracksclear|tracksnewrequests|trackselectionoff|trackselectionon|requestsdisable|requestsenable)\s*$/i);
	if (moderatorCommand) {
		if (!tags["user-id"]) {
			queueChatMessage(`@${chatDisplayName}, I couldn't verify your Twitch account. Please try again.`);
			return;
		}
		try {
			const user = { id: tags["user-id"], login: username, displayName: chatDisplayName };
			if (!(await isModerator(user))) {
				queueChatMessage(`@${chatDisplayName}, only a channel moderator can use that command.`);
				return;
			}
			switch (moderatorCommand[1].toLowerCase()) {
				case "tracksclear":
					resetTrackList();
					break;
				case "tracksnewrequests":
					allowNewRequests();
					break;
				case "trackselectionoff":
					setTrackSelectionEnabled(false);
					break;
				case "trackselectionon":
					setTrackSelectionEnabled(true);
					break;
				case "requestsdisable":
					setRequestsEnabled(false);
					break;
				case "requestsenable":
					setRequestsEnabled(true);
					break;
			}
		} catch (error) {
			log("chat.moderator_command.error", { command: moderatorCommand[1], message: error.message });
			queueChatMessage(`@${chatDisplayName}, I couldn't process that command. Please try again.`);
		}
		return;
	}
	if (/^!tracks\s*$/i.test(message)) {
		queueTrackList(tags["display-name"] || username);
		return;
	}
	const addedCommand = message.match(/^!added(?:\s+(.+))?$/i);
	if (addedCommand) {
		const displayName = tags["display-name"] || username;
		if (!tags["user-id"]) {
			queueChatMessage(`@${displayName}, I couldn't verify your Twitch account. Please try again.`);
			return;
		}
		const name = addedCommand[1] && addedCommand[1].trim();
		if (!name) {
			queueChatMessage(`@${displayName}, use !added <track name>.`);
			return;
		}
		try {
			const user = { id: tags["user-id"], login: username, displayName };
			if (!(await isModerator(user))) {
				queueChatMessage(`@${displayName}, only a channel moderator can mark a track as added.`);
				return;
			}
			const track = resolveRequestedTrack(name);
			if (!track) {
				queueChatMessage(`@${displayName}, I couldn't match that track. Check the spelling or use !tracks to see the list.`);
				return;
			}
			const item = requests.find(request => request.trackId === track.id);
			if (!item) {
				queueChatMessage(`@${displayName}, ${track.name} isn't in the track queue.`);
				return;
			}
			completeRequest(item.id);
			queueChatMessage(`@${displayName}, ${track.name} has been added to the track list.`);
		} catch (error) {
			log("chat.added.error", { message: error.message });
			queueChatMessage(`@${displayName}, I couldn't mark that track as added. Please try again.`);
		}
		return;
	}
	const command = message.match(/^!track(?:\s+(.+))?$/i);
	if (!command) return;
	const displayName = tags["display-name"] || username;
	let name = command[1] && command[1].trim();
	if (!name) {
		log("chat.command_help.requested", {
			username,
			userId: tags["user-id"] || null,
			chatConnected,
			chatConnectionState,
		});
	}
	if (!tags["user-id"]) {
		queueChatMessage(`@${displayName}, I couldn't verify your Twitch account. Please try again.`);
		return;
	}
	if (!name) {
		const helpMessages = [
			`Track requests: ${baseUrl}`,
			"!track <track name> - request a track.",
			"!track <track name> @username - request a track for a recent chatter (moderators only).",
			"!tracks - list the configured tracks.",
			"!added <track name> - mark a queued track as added (moderators only).",
			"!tracksclear - clear the track list and reset request limits (moderators only).",
			"!tracksnewrequests - reset request limits and keep the current queue (moderators only).",
			"!trackselectionoff / !trackselectionon - disable or enable track selection (moderators only).",
			"!requestsdisable / !requestsenable - disable or enable new requests (moderators only).",
			"!track - send this command help again as whispers.",
		];
		for (const [index, helpMessage] of helpMessages.entries()) {
			try {
				await queueChatWhisper(tags["user-id"], helpMessage);
			} catch (error) {
				const details = {
					recipientId: tags["user-id"],
					messageIndex: index + 1,
					messageCount: helpMessages.length,
					upstreamStatus: error.upstreamStatus || null,
					status: error.status || null,
					message: error.message,
				};
				log("chat.command_help.whisper_error", details);
				console.warn("[track-requests]", JSON.stringify({
					timestamp: new Date().toISOString(),
					event: "chat.command_help.whisper_error",
					...details,
				}));
				break;
			}
		}
		return;
	}
	const user = { id: tags["user-id"], login: username, displayName };
	let assignedUser;
	try {
		const moderator = await isModerator(user);
		const assignmentMatch = name.match(/^(.+?)\s+@([a-zA-Z0-9_]+)$/);
		if (assignmentMatch) {
			if (!moderator) {
				queueChatMessage(`@${displayName}, only a channel moderator can assign a track to another chatter.`);
				return;
			}
			name = assignmentMatch[1].trim();
			const chatter = findRecentChatter(assignmentMatch[2]);
			if (!chatter) {
				queueChatMessage(`@${displayName}, I couldn't find @${assignmentMatch[2]} among recent chatters.`);
				return;
			}
			assignedUser = {
				id: chatter.id,
				login: chatter.login,
				displayName: chatter.displayName,
				profileImageUrl: await getRequestAvatar(chatter.id, "chat-assignment"),
			};
		}
		if (!assignedUser && !moderator && requestedUsers.has(user.id)) {
			queueChatMessage(`@${displayName}, you already requested a track this round.`);
			return;
		}
		const track = resolveRequestedTrack(name);
		if (!track) {
			queueChatMessage(`@${displayName}, I couldn't match that track. Check the spelling or use !tracks to see the list.`);
			return;
		}
		if (!assignedUser) user.profileImageUrl = await getRequestAvatar(user.id, "chat");
		createTrackRequest(user, track, moderator, "chat", assignedUser);
		queueChatMessage(assignedUser
			? `@${displayName}, ${track.name} has been queued for @${assignedUser.login}.`
			: `@${displayName}, ${track.name} has been added to the queue.`);
	} catch (error) {
		if (error instanceof HttpError && error.status === 409) {
			queueChatMessage(assignedUser
				? `@${displayName}, ${error.message} for @${assignedUser.login}.`
				: `@${displayName}, ${error.message}`);
			return;
		}
		log("chat.command.error", { message: error.message });
		queueChatMessage(`@${displayName}, I couldn't process that request. Please try again.`);
	}
}

async function createChatSubscription(sessionId) {
	if (!streamerAuthorization) {
		throw new HttpError(503, "Connect the channel account before subscribing to chat.");
	}
	const authorization = getChatAuthorization();
	const userId = authorization && (authorization.userId || authorization.broadcasterId);
	if (!userId) {
		throw new HttpError(503, "Connect the chat account before subscribing to chat.");
	}
	const accessToken = await getChatAccessToken();
	await twitchFetch("https://api.twitch.tv/helix/eventsub/subscriptions", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Client-Id": clientId,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			type: "channel.chat.message",
			version: "1",
			condition: {
				broadcaster_user_id: streamerAuthorization.broadcasterId,
				user_id: userId,
			},
			transport: { method: "websocket", session_id: sessionId },
		}),
	});
}

function processEventSubNotification(payload) {
	const metadata = payload.metadata || {};
	if (metadata.message_type === "session_welcome") {
		const sessionId = payload.payload && payload.payload.session
			&& payload.payload.session.id;
		if (!payload.resuming && !sessionId) {
			chatConnected = false;
			chatConnectionState = "disconnected";
			log("chat.eventsub.invalid_welcome");
			payload.socket.close();
			return;
		}
		const previousSocket = eventSubSocket;
		eventSubReconnectUrl = undefined;
		if (previousSocket && previousSocket !== payload.socket) previousSocket.close();
		if (payload.resuming) {
			chatConnected = true;
			chatConnectionState = "connected";
			log("chat.eventsub.reconnected", { channel: config.channel });
		} else {
			chatConnected = false;
			chatConnectionState = "connecting";
			void createChatSubscription(sessionId).then(() => {
				if (eventSubSocket !== payload.socket) return;
				chatConnected = true;
				chatConnectionState = "connected";
				log("chat.eventsub.connected", { channel: config.channel });
				sendNextChatMessage();
			}).catch(error => {
				if (eventSubSocket !== payload.socket) return;
				chatConnected = false;
				chatConnectionState = error.upstreamStatus === 401 || error.upstreamStatus === 403
					? "needs-authorization"
					: "disconnected";
				log("chat.eventsub.subscription.error", { message: error.message });
				payload.socket.close();
				if (chatConnectionState === "disconnected") scheduleChatReconnect();
			});
		}
		return;
	}
	if (metadata.message_type === "session_reconnect") {
		const reconnectUrl = payload.payload && payload.payload.session
			&& payload.payload.session.reconnect_url;
		if (!reconnectUrl) {
			throw new Error("Twitch EventSub requested a reconnect without a reconnect URL.");
		}
		eventSubReconnectUrl = reconnectUrl;
		void connectTwitchChat(reconnectUrl, true);
		return;
	}
	if (metadata.message_type === "revocation") {
		chatConnected = false;
		chatConnectionState = "needs-authorization";
		log("chat.eventsub.revoked", {
			status: payload.payload && payload.payload.subscription
				&& payload.payload.subscription.status,
		});
		if (eventSubSocket) eventSubSocket.close();
		return;
	}
	if (metadata.message_type !== "notification") return;
	const notification = payload.payload;
	const event = notification && notification.event;
	if (!event || !notification.subscription || notification.subscription.type !== "channel.chat.message"
		|| event.broadcaster_user_id !== (streamerAuthorization && streamerAuthorization.broadcasterId)
		|| typeof event.message?.text !== "string") {
		return;
	}
	const username = event.chatter_user_login;
	const tags = {
		"user-id": event.chatter_user_id,
		"display-name": event.chatter_user_name || username,
	};
	if (typeof username !== "string" || !tags["user-id"]) return;
	recordRecentChatter(tags, username);
	void handleChatMessage(tags, username, event.message.text);
}

function handleEventSubMessage(socket, data, resuming) {
	let payload;
	try {
		payload = JSON.parse(data.toString());
	} catch (error) {
		log("chat.eventsub.invalid_message", { message: error.message });
		return;
	}
	try {
		processEventSubNotification({ ...payload, socket, resuming });
	} catch (error) {
		log("chat.eventsub.message.error", { message: error.message });
	}
}

async function connectTwitchChat(url, resuming = false) {
	if (!hasChatScopes() || !streamerAuthorization
		|| (usesSeparateChatAccount() && !hasChannelBotScope())) {
		chatConnectionState = getChatAuthorization() ? "needs-authorization" : "awaiting-authorization";
		chatConnected = false;
		return;
	}
	if (chatReconnectTimer) {
		clearTimeout(chatReconnectTimer);
		chatReconnectTimer = undefined;
	}
	if (!resuming && eventSubSocket) {
		const previousSocket = eventSubSocket;
		eventSubSocket = undefined;
		previousSocket.close();
	}
	chatConnectionState = "connecting";
	try {
		if (!resuming) await getChatAccessToken();
		if (!hasChatScopes()) {
			chatConnectionState = "needs-authorization";
			return;
		}
		const socket = new WebSocket(url || eventSubReconnectUrl || "wss://eventsub.wss.twitch.tv/ws");
		eventSubSocket = socket;
		socket.on("message", data => handleEventSubMessage(socket, data, resuming));
		socket.on("error", error => {
			log("chat.eventsub.socket.error", { message: error.message });
		});
		socket.on("close", () => {
			if (eventSubSocket !== socket) return;
			eventSubSocket = undefined;
			chatConnected = false;
			if (chatConnectionState !== "needs-authorization") {
				chatConnectionState = "disconnected";
				eventSubReconnectUrl = undefined;
				scheduleChatReconnect();
			}
		});
	} catch (error) {
		log("chat.eventsub.connect.error", { message: error.message });
		chatConnected = false;
		chatConnectionState = error instanceof HttpError && error.status === 503
			? "needs-authorization"
			: "disconnected";
		if (chatConnectionState === "disconnected") scheduleChatReconnect();
	}
}

function scheduleChatReconnect() {
	if (chatReconnectTimer || !hasChatScopes() || !streamerAuthorization
		|| (usesSeparateChatAccount() && !hasChannelBotScope())) return;
	chatReconnectTimer = setTimeout(() => {
		chatReconnectTimer = undefined;
		void connectTwitchChat();
	}, 5000);
	chatReconnectTimer.unref();
}

function startLogin(request, response, flow) {
	for (const [state, pending] of pendingLogins) {
		if (pending.expiresAt <= Date.now()) pendingLogins.delete(state);
	}
	const state = randomToken();
	pendingLogins.set(state, { flow, expiresAt: Date.now() + 10 * 60 * 1000 });
	const parameters = new URLSearchParams({
		client_id: clientId,
		redirect_uri: redirectUri,
		response_type: "code",
		state,
	});
	if (flow === "streamer") parameters.set("scope", getStreamerScopes().join(" "));
	if (flow === "chat") parameters.set("scope", getChatScopes().join(" "));
	setOAuthStateCookie(request, response, state);
	response.writeHead(302, {
		Location: `https://id.twitch.tv/oauth2/authorize?${parameters}`,
		"Cache-Control": "no-store",
	});
	response.end();
}

async function handleCallback(request, response, url) {
	const state = url.searchParams.get("state");
	const pending = state && pendingLogins.get(state);
	if (!pending || pending.expiresAt <= Date.now() || getCookies(request).oauth_state !== state) {
		if (state) pendingLogins.delete(state);
		throw new HttpError(400, "The Twitch login has expired or its state is invalid. Start again.");
	}
	pendingLogins.delete(state);
	setOAuthStateCookie(request, response, state, true);
	if (url.searchParams.has("error")) {
		throw new HttpError(400, url.searchParams.get("error_description") || "Twitch authorization was cancelled.");
	}
	const code = url.searchParams.get("code");
	if (!code) throw new HttpError(400, "Twitch did not return an authorization code.");

	const token = await exchangeCode(code);
	if (!token.access_token) throw new HttpError(502, "Twitch did not return an access token.");
	const user = await getTwitchUser(token.access_token);
	if (pending.flow === "streamer") {
		if (user.login.toLowerCase() !== config.channel.toLowerCase()) {
			throw new HttpError(403, `Connect the Twitch account for ${config.channel} to enable moderator tools.`);
		}
		const missingScopes = getStreamerScopes().filter(scope => !token.scope || !token.scope.includes(scope));
		if (missingScopes.length) {
			throw new HttpError(403, `The channel account must authorize these scopes: ${missingScopes.join(", ")}.`);
		}
		if (!token.access_token || !token.refresh_token || !token.expires_in) {
			throw new HttpError(502, "Twitch did not return complete channel authorization details.");
		}
		const authorization = {
			accessToken: token.access_token,
			refreshToken: token.refresh_token,
			expiresAt: Date.now() + token.expires_in * 1000,
			broadcasterId: user.id,
			scopes: token.scope,
		};
		persistAuthorizations(authorization, chatAuthorization);
		streamerAuthorization = authorization;
		void connectTwitchChat();
	} else if (pending.flow === "chat") {
		if (!usesSeparateChatAccount()) {
			throw new HttpError(400, "Set config.chatUser to a different Twitch account before connecting a chat account.");
		}
		if (user.login.toLowerCase() !== configuredChatUser()) {
			throw new HttpError(403, `Connect the configured chat account @${configuredChatUser()}.`);
		}
		const missingScopes = getChatScopes().filter(scope => !token.scope || !token.scope.includes(scope));
		if (missingScopes.length) {
			throw new HttpError(403, `The chat account must authorize these scopes: ${missingScopes.join(", ")}.`);
		}
		if (!token.access_token || !token.refresh_token || !token.expires_in) {
			throw new HttpError(502, "Twitch did not return complete chat authorization details.");
		}
		const authorization = {
			userId: user.id,
			login: user.login.toLowerCase(),
			accessToken: token.access_token,
			refreshToken: token.refresh_token,
			expiresAt: Date.now() + token.expires_in * 1000,
			scopes: token.scope,
		};
		persistAuthorizations(streamerAuthorization, authorization);
		chatAuthorization = authorization;
		void connectTwitchChat();
	}

	if (pending.flow !== "chat") {
		const { sessionId } = createSession({
			id: user.id,
			login: user.login,
			displayName: user.display_name,
			profileImageUrl: user.profile_image_url || null,
		});
		setSessionCookie(request, response, sessionId);
	}
	response.writeHead(302, { Location: "/", "Cache-Control": "no-store" });
	response.end();
}

function getAuthorization(flow) {
	return flow === "chat" ? chatAuthorization : streamerAuthorization;
}

function setAuthorization(flow, authorization) {
	const broadcaster = flow === "streamer" ? authorization : streamerAuthorization;
	const chat = flow === "chat" ? authorization : chatAuthorization;
	persistAuthorizations(broadcaster, chat);
	if (flow === "chat") chatAuthorization = authorization;
	else streamerAuthorization = authorization;
}

async function getAuthorizationAccessToken(flow) {
	const authorization = getAuthorization(flow);
	const accountName = flow === "chat" ? "chat" : "channel";
	if (!authorization) {
		throw new HttpError(503, `The ${accountName} Twitch account has not been connected yet.`);
	}
	if (authorization.expiresAt > Date.now() + 60 * 1000) return authorization.accessToken;
	const refreshPromise = flow === "chat" ? chatRefreshPromise : streamerRefreshPromise;
	if (refreshPromise) return refreshPromise;
	const nextRefreshPromise = refreshAuthorizationAccessToken(flow);
	if (flow === "chat") chatRefreshPromise = nextRefreshPromise;
	else streamerRefreshPromise = nextRefreshPromise;
	try {
		return await nextRefreshPromise;
	} finally {
		if (flow === "chat") chatRefreshPromise = undefined;
		else streamerRefreshPromise = undefined;
	}
}

async function refreshAuthorizationAccessToken(flow) {
	const currentAuthorization = getAuthorization(flow);
	const accountName = flow === "chat" ? "chat" : "channel";
	if (!currentAuthorization) {
		throw new HttpError(503, `The ${accountName} Twitch account has not been connected yet.`);
	}
	const body = new URLSearchParams({
		client_id: clientId,
		client_secret: clientSecret,
		grant_type: "refresh_token",
		refresh_token: currentAuthorization.refreshToken,
	});
	let token;
	try {
		token = await twitchFetch("https://id.twitch.tv/oauth2/token", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body,
		});
	} catch (error) {
		if (error instanceof HttpError && error.status === 502) {
			setAuthorization(flow, undefined);
			throw new HttpError(503, `The ${accountName} Twitch authorization expired. Reconnect the ${accountName} account.`);
		}
		throw error;
	}
	if (!token.access_token || !token.refresh_token || !token.expires_in) {
		setAuthorization(flow, undefined);
		throw new HttpError(503, `Twitch could not refresh ${accountName} access. Reconnect the ${accountName} account.`);
	}
	const authorization = {
		...currentAuthorization,
		accessToken: token.access_token,
		refreshToken: token.refresh_token,
		expiresAt: Date.now() + token.expires_in * 1000,
		scopes: token.scope || currentAuthorization.scopes,
	};
	setAuthorization(flow, authorization);
	return authorization.accessToken;
}

async function getStreamerAccessToken() {
	return getAuthorizationAccessToken("streamer");
}

async function getChatAccessToken() {
	return getAuthorizationAccessToken(usesSeparateChatAccount() ? "chat" : "streamer");
}

async function isModerator(user) {
	if (user.login.toLowerCase() === config.channel.toLowerCase()) return true;
	if (!streamerAuthorization) return false;
	const accessToken = await getStreamerAccessToken();
	const parameters = new URLSearchParams({
		broadcaster_id: streamerAuthorization.broadcasterId,
		user_id: user.id,
	});
	const result = await twitchFetch(`https://api.twitch.tv/helix/moderation/moderators?${parameters}`, {
		headers: { Authorization: `Bearer ${accessToken}`, "Client-Id": clientId },
	});
	return Boolean(result.data && result.data.some(moderator => moderator.user_id === user.id));
}

async function getState(request) {
	const session = getSession(request);
	const user = session && session.user;
	const [moderator, channelInfoResult] = await Promise.all([
		user ? isModerator(user) : false,
		getChannelInfo(),
	]);
	const alreadyRequested = Boolean(user && requestedUsers.has(user.id));
	const userHasQueuedRequest = Boolean(user && requests.some(item => item.userId === user.id));
	log("state.generated", {
		hasUser: Boolean(user),
		isModerator: moderator,
		trackSelectionEnabled,
		requestsEnabled,
		alreadyRequested,
		userHasQueuedRequest,
		requestCount: requests.length,
		trackCount: tracks.length,
	});
	return {
		channel: config.channel,
		channelInfo: channelInfoResult.info,
		channelInfoError: channelInfoResult.error,
		tracks,
		requests: requests.map(item => ({
			id: item.id,
			trackId: item.trackId,
			trackName: item.trackName,
			countryCode: item.countryCode,
			requestedBy: item.requestedBy,
			requestedFor: item.requestedFor || null,
			requesterAvatarUrl: item.requesterAvatarUrl || null,
			completed: item.completed,
			createdAt: item.createdAt,
			...(item.completedAt ? { completedAt: item.completedAt } : {}),
		})),
		currentUser: user ? {
			login: user.login,
			displayName: user.displayName,
			profileImageUrl: user.profileImageUrl,
		} : null,
		isStreamer: Boolean(user && user.login.toLowerCase() === config.channel.toLowerCase()),
		isModerator: moderator,
		trackSelectionEnabled,
		requestsEnabled,
		alreadyRequested,
		recentChatters: moderator ? getRecentChatters() : [],
		streamerConnected: Boolean(streamerAuthorization),
		chatAuthorizationReady: hasChatScopes(),
		chatSenderLogin: chatUserLogin(),
		separateChatAccount: usesSeparateChatAccount(),
		chatBotGrantReady: !usesSeparateChatAccount() || hasChannelBotScope(),
		chatConnected,
		chatConnectionState,
	};
}

async function handleApi(request, response, url) {
	if (request.method === "GET" && url.pathname === "/api/state") {
		return sendJson(response, 200, await getState(request));
	}
	if (request.method === "POST" && url.pathname === "/api/reset-tracks") {
		requireHttpApiToken(request);
		resetTrackList();
		return sendJson(response, 200, { ok: true });
	}
	if (request.method === "POST" && url.pathname === "/api/allow-new-requests") {
		requireHttpApiToken(request);
		allowNewRequests();
		return sendJson(response, 200, { ok: true });
	}
	if (request.method === "POST" && url.pathname === "/api/disable-track-selection") {
		requireHttpApiToken(request);
		setTrackSelectionEnabled(false);
		return sendJson(response, 200, { ok: true, trackSelectionEnabled });
	}
	if (request.method === "POST" && url.pathname === "/api/enable-track-selection") {
		requireHttpApiToken(request);
		setTrackSelectionEnabled(true);
		return sendJson(response, 200, { ok: true, trackSelectionEnabled });
	}
	if (request.method === "POST" && url.pathname === "/api/disable-requests") {
		requireHttpApiToken(request);
		setRequestsEnabled(false);
		return sendJson(response, 200, { ok: true, requestsEnabled });
	}
	if (request.method === "POST" && url.pathname === "/api/enable-requests") {
		requireHttpApiToken(request);
		setRequestsEnabled(true);
		return sendJson(response, 200, { ok: true, requestsEnabled });
	}
	if (request.method === "POST" && url.pathname === "/api/complete-next") {
		requireHttpApiToken(request);
		const item = requests.find(entry => !entry.completed);
		if (!item) throw new HttpError(409, "There are no pending track requests to complete.");
		completeRequest(item.id);
		return sendJson(response, 200, { ok: true, requestId: item.id, trackName: item.trackName });
	}
	const httpApiCompletionMatch = url.pathname.match(/^\/api\/requests\/([0-9a-f-]+)\/complete$/i);
	if (request.method === "POST" && httpApiCompletionMatch) {
		requireHttpApiToken(request);
		const item = completeRequest(httpApiCompletionMatch[1]);
		return sendJson(response, 200, { ok: true, requestId: item.id, trackName: item.trackName });
	}
	if (request.method === "GET" && url.pathname === "/api/session") {
		const session = getSession(request);
		return sendJson(response, 200, { csrfToken: session ? session.csrfToken : null });
	}
	if (request.method === "POST" && url.pathname === "/api/requests") {
		const session = requireSession(request);
		requireCsrf(request, session);
		const body = await readJson(request);
		if (!body || typeof body !== "object" || typeof body.trackId !== "string" || !trackIds.has(body.trackId)) {
			log("request.rejected", { reason: "invalid-track" });
			throw new HttpError(400, "Select a valid track.");
		}
		const moderator = await isModerator(session.user);
		const track = tracks.find(item => item.id === body.trackId);
		let assignedUser;
		if (body.assignToUserId !== undefined && body.assignToUserId !== null && body.assignToUserId !== "") {
			if (!moderator) throw new HttpError(403, "Only a channel moderator can assign a track to another chatter.");
			if (typeof body.assignToUserId !== "string") {
				throw new HttpError(400, "Select a valid recent chatter.");
			}
			const chatter = getRecentChatters().find(item => item.id === body.assignToUserId);
			if (!chatter) throw new HttpError(400, "That chatter is no longer recent. Refresh the page and select someone else.");
			assignedUser = {
				id: chatter.id,
				login: chatter.login,
				displayName: chatter.displayName,
				profileImageUrl: await getRequestAvatar(chatter.id, "web-assignment"),
			};
		}
		createTrackRequest(session.user, track, moderator, "web", assignedUser);
		return sendJson(response, 201, { ok: true });
	}
	if (request.method === "POST" && url.pathname === "/api/reset/tracks") {
		const session = requireSession(request);
		requireCsrf(request, session);
		if (!(await isModerator(session.user))) throw new HttpError(403, "Only a moderator of this channel can reset requests.");
		resetTrackList();
		return sendJson(response, 200, { ok: true });
	}
	if (request.method === "POST" && url.pathname === "/api/reset/allow-new-requests") {
		const session = requireSession(request);
		requireCsrf(request, session);
		if (!(await isModerator(session.user))) throw new HttpError(403, "Only a moderator of this channel can reset requests.");
		allowNewRequests();
		return sendJson(response, 200, { ok: true });
	}
	const moderatorActions = {
		"/api/moderator/track-selection/disable": () => setTrackSelectionEnabled(false),
		"/api/moderator/track-selection/enable": () => setTrackSelectionEnabled(true),
		"/api/moderator/requests/disable": () => setRequestsEnabled(false),
		"/api/moderator/requests/enable": () => setRequestsEnabled(true),
	};
	if (request.method === "POST" && moderatorActions[url.pathname]) {
		const session = requireSession(request);
		requireCsrf(request, session);
		if (!(await isModerator(session.user))) throw new HttpError(403, "Only a moderator of this channel can change request availability.");
		moderatorActions[url.pathname]();
		return sendJson(response, 200, { ok: true, trackSelectionEnabled, requestsEnabled });
	}
	const completionMatch = url.pathname.match(/^\/api\/requests\/([0-9a-f-]+)\/complete$/i);
	if (request.method === "POST" && completionMatch) {
		const session = requireSession(request);
		requireCsrf(request, session);
		if (session.user.login.toLowerCase() !== config.channel.toLowerCase()) {
			throw new HttpError(403, "Only the streamer can mark a request complete.");
		}
		completeRequest(completionMatch[1]);
		return sendJson(response, 200, { ok: true });
	}
	if (request.method === "POST" && url.pathname === "/api/logout") {
		const session = requireSession(request);
		requireCsrf(request, session);
		const sessionId = getCookies(request).track_session;
		sessions.delete(sessionId);
		response.setHeader("Set-Cookie", [
			"track_session=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0",
		]);
		return sendJson(response, 200, { ok: true });
	}
	throw new HttpError(404, "API endpoint not found.");
}

function serveStatic(response, url) {
	let pathname;
	try {
		pathname = decodeURIComponent(url.pathname);
	} catch {
		throw new HttpError(400, "The requested path is invalid.");
	}
	if (pathname === "/") pathname = "/index.html";
	const publicFiles = new Map([
		["/index.html", "index.html"],
		["/app.js", "app.js"],
		["/styles.css", "styles.css"],
	]);
	const publicFile = publicFiles.get(pathname);
	if (!publicFile) throw new HttpError(404, "Not found.");
	const filePath = path.join(__dirname, publicFile);
	let content;
	try {
		content = fs.readFileSync(filePath);
	} catch (error) {
		if (error.code === "ENOENT" || error.code === "EISDIR") throw new HttpError(404, "Not found.");
		throw error;
	}
	const contentTypes = {
		".css": "text/css; charset=utf-8",
		".html": "text/html; charset=utf-8",
		".js": "text/javascript; charset=utf-8",
	};
	response.writeHead(200, {
		"Content-Type": contentTypes[path.extname(filePath)] || "application/octet-stream",
		"Cache-Control": "no-store",
	});
	response.end(content);
}

async function handleRequest(request, response) {
	const startedAt = Date.now();
	let requestPath = "/";
	response.setHeader("X-Content-Type-Options", "nosniff");
	response.setHeader("X-Frame-Options", "DENY");
	response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
	response.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' https://static-cdn.jtvnw.net; connect-src 'self'; base-uri 'self'; frame-ancestors 'none'");
	try {
		const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
		requestPath = url.pathname;
		if (requestPath.startsWith("/api/")) {
			log("api.request", { method: request.method, path: requestPath });
			response.once("finish", () => log("api.response", {
				method: request.method,
				path: requestPath,
				status: response.statusCode,
				durationMs: Date.now() - startedAt,
			}));
		}
		if (url.pathname === "/auth/login" && request.method === "GET") {
			const flow = url.searchParams.get("as") || "viewer";
			if (flow !== "viewer" && flow !== "streamer" && flow !== "chat") {
				throw new HttpError(400, "Unknown Twitch login type.");
			}
			if (flow === "chat" && !usesSeparateChatAccount()) {
				throw new HttpError(400, "Set config.chatUser to a different Twitch account before connecting a chat account.");
			}
			return startLogin(request, response, flow);
		}
		if (url.pathname === "/auth/callback" && request.method === "GET") {
			return await handleCallback(request, response, url);
		}
		if (url.pathname.startsWith("/api/")) {
			return await handleApi(request, response, url);
		}
		if (request.method !== "GET" && request.method !== "HEAD") {
			throw new HttpError(405, "Method not allowed.");
		}
		return serveStatic(response, url);
	} catch (error) {
		if (response.headersSent) {
			response.destroy(error);
			return;
		}
		if (error instanceof HttpError) {
			if (requestPath.startsWith("/api/")) {
				log("api.error", { method: request.method, path: requestPath, status: error.status, message: error.message });
			}
			if (request.url.startsWith("/api/")) return sendJson(response, error.status, { error: error.message });
			return sendText(response, error.status, error.message);
		}
		log("request.error", { method: request.method, path: requestPath, message: error.message });
		console.error("Request failed:", error);
		if (request.url.startsWith("/api/")) return sendJson(response, 500, { error: "An unexpected server error occurred." });
		return sendText(response, 500, "An unexpected server error occurred.");
	}
}

validateConfig();
({ broadcaster: streamerAuthorization, chat: chatAuthorization } = loadAuthorizations());
if (streamerAuthorization) {
	log("streamer.authorization.loaded", { channel: config.channel });
}
if (chatAuthorization) {
	log("chat.authorization.loaded", { login: chatAuthorization.login });
}
const server = http.createServer((request, response) => {
	handleRequest(request, response);
});
apiWebSocketServer = new WebSocket.Server({ noServer: true, maxPayload: 4096 });
apiWebSocketServer.on("connection", (socket, request) => {
	apiWebSocketRequests.set(socket, request);
	socket.send(JSON.stringify(getApiConfigurationState()), error => {
		if (error) log("http-api.websocket.send-error", { message: error.message });
	});
	void sendApiPageState(socket, request, stateRevision);
	socket.on("message", (data, isBinary) => handleApiWebSocketCommand(socket, data, isBinary));
});
server.on("upgrade", (request, socket, head) => {
	let url;
	try {
		url = new URL(request.url, "http://localhost");
	} catch {
		socket.destroy();
		return;
	}
	if (url.pathname !== "/api/events") {
		socket.destroy();
		return;
	}
	const origin = request.headers.origin;
	if (origin) {
		try {
			const originUrl = new URL(origin);
			if ((originUrl.protocol !== "http:" && originUrl.protocol !== "https:")
				|| originUrl.host !== request.headers.host) {
				socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
				return;
			}
		} catch {
			socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
			return;
		}
	}
	if (!request.headers.host) {
		socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
		return;
	}
	apiWebSocketServer.handleUpgrade(request, socket, head, webSocket => {
		apiWebSocketServer.emit("connection", webSocket, request);
	});
});
server.listen(config.port, () => {
	if (verbose) {
		console.log(`F1 track requests listening on http://localhost:${config.port}`);
		console.log(`Configured Twitch channel: ${config.channel}`);
	}
	void connectTwitchChat();
});
