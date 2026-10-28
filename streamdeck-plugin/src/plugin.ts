import { randomUUID } from "node:crypto";
import streamDeck, {
	action,
	type Action,
	type KeyAction,
	type KeyDownEvent,
	type WillAppearEvent,
	type WillDisappearEvent,
	SingletonAction,
} from "@elgato/streamdeck";
import WebSocket from "ws";

const pluginUuid = "com.gently.f1-track-requests";
const commandTimeoutMs = 8000;

type GlobalSettings = {
	serverUrl?: string;
	token?: string;
};

type ActionSettings = {
	requestId?: string;
};

type ApiState = {
	trackSelectionEnabled: boolean;
	requestsEnabled: boolean;
};

type ApiStateListener = (state: ApiState | undefined) => void | Promise<void>;

type ApiCommandResult = {
	type: "result";
	commandId: string;
	ok: boolean;
	error?: string;
};

function getServerBase(serverUrl?: string): URL {
	if (!serverUrl || !serverUrl.trim()) {
		throw new Error("Set the HTTP API server URL in the action's property inspector.");
	}

	let base: URL;
	try {
		base = new URL(serverUrl.trim());
	} catch {
		throw new Error("The HTTP API server URL is not valid.");
	}

	if (base.protocol !== "http:" && base.protocol !== "https:") {
		throw new Error("The HTTP API server URL must use HTTP or HTTPS.");
	}

	base.pathname = `${base.pathname.replace(/\/+$/, "")}/`;
	base.search = "";
	base.hash = "";
	return base;
}

function isKeyAction(action: Action<GlobalSettings>): action is KeyAction<GlobalSettings> {
	return action.controllerType === "Keypad";
}

class ApiConnection {
	private settings: GlobalSettings = {};
	private socket: WebSocket | undefined;
	private retryTimer: ReturnType<typeof setTimeout> | undefined;
	private retryDelayMs = 1000;
	private generation = 0;
	private currentState: ApiState | undefined;
	private listeners = new Set<ApiStateListener>();
	private pendingCommands = new Map<string, {
		resolve: () => void;
		reject: (error: Error) => void;
		timer: ReturnType<typeof setTimeout>;
	}>();
	private lastError: string | undefined;

	get state(): ApiState | undefined {
		return this.currentState;
	}

	subscribe(listener: ApiStateListener): () => void {
		this.listeners.add(listener);
		void listener(this.currentState);
		return () => this.listeners.delete(listener);
	}

	configure(settings: GlobalSettings): void {
		if (settings.serverUrl === this.settings.serverUrl && settings.token === this.settings.token) return;

		this.settings = { serverUrl: settings.serverUrl, token: settings.token };
		this.generation++;
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.retryTimer = undefined;
		this.socket?.close();
		this.socket = undefined;
		this.failPendingCommands(new Error("HTTP API settings changed before the command completed."));
		this.retryDelayMs = 1000;
		this.lastError = undefined;
		this.publish(undefined);

		if (!this.settings.serverUrl) return;
		this.connect(this.generation);
	}

	private connect(generation: number): void {
		let socket: WebSocket;
		try {
			const token = requireToken(this.settings);
			const url = getServerBase(this.settings.serverUrl);
			url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
			url.pathname = `${url.pathname}api/events`;
			socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
		} catch (error) {
			this.reportError(error);
			this.scheduleReconnect(generation);
			return;
		}

		this.socket = socket;
		socket.on("message", data => {
			if (generation !== this.generation || socket !== this.socket) return;
			let message: unknown;
			try {
				message = JSON.parse(data.toString());
			} catch {
				this.reportError(new Error("The HTTP API WebSocket sent invalid JSON."));
				return;
			}
			if (isApiCommandResult(message)) {
				this.handleCommandResult(message);
				return;
			}
			if (isApiPageState(message)) return;
			if (!isApiState(message)) {
				this.reportError(new Error("The HTTP API WebSocket sent an unsupported state message."));
				return;
			}
			this.lastError = undefined;
			this.retryDelayMs = 1000;
			this.publish(message);
		});
		socket.on("error", error => {
			if (generation === this.generation && socket === this.socket) this.reportError(error);
		});
		socket.on("close", () => {
			if (generation !== this.generation || socket !== this.socket) return;
			this.socket = undefined;
			this.failPendingCommands(new Error("The HTTP API WebSocket disconnected before the command completed."));
			this.publish(undefined);
			this.scheduleReconnect(generation);
		});
	}

	command(action: string, token: string, requestId?: string): Promise<void> {
		const socket = this.socket;
		if (!socket || socket.readyState !== WebSocket.OPEN) {
			return Promise.reject(new Error("The HTTP API WebSocket is not connected."));
		}

		const commandId = randomUUID();
		const message = {
			type: "command",
			commandId,
			action,
			token,
			...(requestId ? { requestId } : {}),
		};
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingCommands.delete(commandId);
				reject(new Error("The HTTP API command timed out."));
			}, commandTimeoutMs);
			this.pendingCommands.set(commandId, { resolve, reject, timer });
			socket.send(JSON.stringify(message), error => {
				if (!error) return;
				const pending = this.pendingCommands.get(commandId);
				if (!pending) return;
				clearTimeout(pending.timer);
				this.pendingCommands.delete(commandId);
				pending.reject(error);
			});
		});
	}

	private scheduleReconnect(generation: number): void {
		if (generation !== this.generation || this.retryTimer) return;
		this.retryTimer = setTimeout(() => {
			this.retryTimer = undefined;
			this.connect(generation);
		}, this.retryDelayMs);
		this.retryDelayMs = Math.min(this.retryDelayMs * 2, 30000);
	}

	private publish(state: ApiState | undefined): void {
		this.currentState = state;
		for (const listener of this.listeners) {
			void Promise.resolve(listener(state)).catch(error => {
				streamDeck.logger.error("Unable to update HTTP API action state", error);
			});
		}
	}

	private handleCommandResult(result: ApiCommandResult): void {
		const pending = this.pendingCommands.get(result.commandId);
		if (!pending) return;
		clearTimeout(pending.timer);
		this.pendingCommands.delete(result.commandId);
		if (result.ok) pending.resolve();
		else pending.reject(new Error(result.error || "The HTTP API command failed."));
	}

	private failPendingCommands(error: Error): void {
		for (const pending of this.pendingCommands.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pendingCommands.clear();
	}

	private reportError(error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		if (message === this.lastError) return;
		this.lastError = message;
		streamDeck.logger.error("HTTP API WebSocket error", error);
	}
}

function isApiState(message: unknown): message is ApiState {
	return typeof message === "object" && message !== null
		&& "type" in message && message.type === "state"
		&& "trackSelectionEnabled" in message && typeof message.trackSelectionEnabled === "boolean"
		&& "requestsEnabled" in message && typeof message.requestsEnabled === "boolean";
}

function isApiPageState(message: unknown): boolean {
	return typeof message === "object" && message !== null
		&& "type" in message && message.type === "page-state";
}

function isApiCommandResult(message: unknown): message is ApiCommandResult {
	return typeof message === "object" && message !== null
		&& "type" in message && message.type === "result"
		&& "commandId" in message && typeof message.commandId === "string"
		&& "ok" in message && typeof message.ok === "boolean"
		&& (!("error" in message) || typeof message.error === "string");
}

const apiConnection = new ApiConnection();

abstract class ToggleAction extends SingletonAction<GlobalSettings> {
	protected abstract getEnabled(state: ApiState): boolean;
	protected abstract getEnabledCommand(): string;
	protected abstract getDisabledCommand(): string;

	private visibleActions = new Map<string, KeyAction<GlobalSettings>>();

	override async onWillAppear(ev: WillAppearEvent<GlobalSettings>): Promise<void> {
		if (!isKeyAction(ev.action)) return;
		this.visibleActions.set(ev.action.id, ev.action);
		await this.updateState(apiConnection.state);
	}

	override onWillDisappear(ev: WillDisappearEvent<GlobalSettings>): void {
		this.visibleActions.delete(ev.action.id);
	}

	override async onKeyDown(ev: KeyDownEvent<GlobalSettings>): Promise<void> {
		try {
			const settings = await streamDeck.settings.getGlobalSettings<GlobalSettings>();
			const state = apiConnection.state;
			if (!state) throw new Error("Waiting for the HTTP API WebSocket state.");
			const command = this.getEnabled(state) ? this.getDisabledCommand() : this.getEnabledCommand();
			await apiConnection.command(command, requireToken(settings));
			await ev.action.showOk();
		} catch (error) {
			streamDeck.logger.error("HTTP API toggle action failed", error);
			await ev.action.showAlert();
		}
	}

	async updateState(state: ApiState | undefined): Promise<void> {
		const visible = [...this.visibleActions.values()];
		if (!visible.length) return;
		if (!state) {
			await Promise.all(visible.map(async button => {
				await button.setImage("imgs/offline.svg");
			}));
			return;
		}
		await Promise.all(visible.map(async button => {
			await button.setImage();
			await button.setState(this.getEnabled(state) ? 0 : 1);
		}));
	}
}

function requireToken(settings: GlobalSettings): string {
	const token = settings.token?.trim();
	if (!token || token.length < 32) {
		throw new Error("Set an HTTP API token of at least 32 characters in the property inspector.");
	}
	return token;
}

@action({ UUID: `${pluginUuid}.toggle-track-selection` })
class ToggleTrackSelectionAction extends ToggleAction {
	protected getEnabled(state: ApiState): boolean {
		return state.trackSelectionEnabled;
	}

	protected getEnabledCommand(): string {
		return "enable-track-selection";
	}

	protected getDisabledCommand(): string {
		return "disable-track-selection";
	}
}

@action({ UUID: `${pluginUuid}.toggle-new-requests` })
class ToggleNewRequestsAction extends ToggleAction {
	protected getEnabled(state: ApiState): boolean {
		return state.requestsEnabled;
	}

	protected getEnabledCommand(): string {
		return "enable-requests";
	}

	protected getDisabledCommand(): string {
		return "disable-requests";
	}
}

@action({ UUID: `${pluginUuid}.reset-tracks` })
class ResetTracksAction extends SingletonAction<GlobalSettings> {
	override async onKeyDown(ev: KeyDownEvent<GlobalSettings>): Promise<void> {
		await postAction(ev, "reset-tracks", "Reset tracks action failed");
	}
}

@action({ UUID: `${pluginUuid}.allow-new-requests` })
class AllowNewRequestsAction extends SingletonAction<GlobalSettings> {
	override async onKeyDown(ev: KeyDownEvent<GlobalSettings>): Promise<void> {
		await postAction(ev, "allow-new-requests", "Allow new requests action failed");
	}
}

@action({ UUID: `${pluginUuid}.complete-next` })
class CompleteNextAction extends SingletonAction<GlobalSettings> {
	override async onKeyDown(ev: KeyDownEvent<GlobalSettings>): Promise<void> {
		await postAction(ev, "complete-next", "Complete next action failed");
	}
}

@action({ UUID: `${pluginUuid}.complete-request` })
class CompleteRequestAction extends SingletonAction<GlobalSettings & ActionSettings> {
	override async onKeyDown(ev: KeyDownEvent<GlobalSettings & ActionSettings>): Promise<void> {
		const requestId = ev.payload.settings.requestId?.trim();
		if (!requestId || !/^[0-9a-f-]{36}$/i.test(requestId)) {
			streamDeck.logger.warn("Complete request action needs a valid request ID.");
			await ev.action.showAlert();
			return;
		}
		await postAction(ev, "complete-request", "Complete request action failed", requestId);
	}
}

async function postAction(
	ev: KeyDownEvent<GlobalSettings>,
	command: string,
	errorLabel: string,
	requestId?: string,
): Promise<void> {
	try {
		const settings = await streamDeck.settings.getGlobalSettings<GlobalSettings>();
		await apiConnection.command(command, requireToken(settings), requestId);
		await ev.action.showOk();
	} catch (error) {
		streamDeck.logger.error(errorLabel, error);
		await ev.action.showAlert();
	}
}

const trackSelectionAction = new ToggleTrackSelectionAction();
const newRequestsAction = new ToggleNewRequestsAction();

apiConnection.subscribe(async state => {
	await Promise.all([
		trackSelectionAction.updateState(state),
		newRequestsAction.updateState(state),
	]);
});

streamDeck.actions.registerAction(trackSelectionAction);
streamDeck.actions.registerAction(newRequestsAction);
streamDeck.actions.registerAction(new ResetTracksAction());
streamDeck.actions.registerAction(new AllowNewRequestsAction());
streamDeck.actions.registerAction(new CompleteNextAction());
streamDeck.actions.registerAction(new CompleteRequestAction());

streamDeck.settings.onDidReceiveGlobalSettings(async ev => {
	apiConnection.configure(ev.settings as GlobalSettings);
});

streamDeck.connect();
void streamDeck.settings.getGlobalSettings<GlobalSettings>()
	.then(settings => apiConnection.configure(settings))
	.catch(error => streamDeck.logger.error("Unable to load HTTP API settings", error));
