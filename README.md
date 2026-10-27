# streamer.bot-utils

## F1 track requests

The standalone `track-requests` web app lets Twitch viewers request configured
F1 circuits. It keeps the queue in memory, blocks duplicate users and tracks,
and allows the channel streamer to mark requests complete. A moderator can clear
the track list or allow users to request again while keeping the queue.
The page header shows the configured channel's Twitch profile picture and,
while live, its stream title.

### Setup

1. Create a Twitch application in the [Twitch Developer Console](https://dev.twitch.tv/console/apps).
   Set its OAuth redirect URL to
   `https://trackrequests.gently.org.uk:7000/auth/callback`.
2. Edit [`track-requests/config.json`](./track-requests/config.json): set
   `channel` to the channel's Twitch login, set `port` to the internal HTTP port
   Traefik will forward to (default `3000`), and set `baseUrl` to the public
   HTTPS URL of the page. This URL is included in the `!track` help whispers.
   Optionally set `chatUser` to a different Twitch login to send chat replies
   from that account. Leave it empty or omit it to use the channel account.
   Set `twitch.clientId` and `twitch.clientSecret` in the config file. The
   callback URI is inferred as `<baseUrl>/auth/callback`; register that exact
   HTTPS URL with Twitch. The app serves plain HTTP only; TLS terminates at
   Traefik. The ordered track list and matching aliases are maintained in
   `track-requests/server.js`.
3. From the `track-requests` directory, run `npm ci` and then `npm start` with
   Node.js 18 or newer. The app listens on `http://localhost:3000` by default.
   Access it through Traefik at `https://trackrequests.gently.org.uk:7000`.
4. Chat is received through Twitch EventSub WebSockets and sent with Twitch's
   Send Chat Message API. If `chatUser` is empty, choose
   **Connect channel account** and authorize `moderation:read`,
   `user:read:chat`, `user:write:chat`, and `user:manage:whispers`. If
   `chatUser` names a different account, connect the channel account with
   `moderation:read` and
   `channel:bot`, then choose **Connect chat account** while signed in as the
   configured user and authorize `user:read:chat`, `user:write:chat`,
   `user:manage:whispers`, and `user:bot`. The streamer should use their
   channel account to mark requests completed. The authorized accounts'
   access and refresh tokens are stored in
   `track-requests/.track-request-auth.json` and refreshed as needed, so they
   do not need to reconnect after a server restart. Keep this file private; it
   is excluded by the app's `.gitignore` and is not served by the web server.

Protect the Twitch client secret, and do not expose it publicly. Keep the
backend HTTP port reachable only by Traefik and trusted local services.

### Verbose logging

Routine server logs are disabled by default. Start the server with `--verbose`
to enable them:

```sh
node server.js --verbose
```

When using the npm start script, pass the option through with
`npm start -- --verbose`. Server errors remain logged without this option.
To enable browser diagnostics, add the `verbose` query parameter to the page
URL, for example `https://trackrequests.gently.org.uk:7000/?verbose`, then check
the browser developer console. Remove the parameter to disable browser logs.

### Traefik routing

Configure a TLS-enabled Traefik entrypoint listening on `:7000`, then route the
whole hostname to the app's internal HTTP port. Do not strip or rewrite paths:
the website, Twitch callback, and HTTP API endpoints all use the same
host router. For a Docker deployment, add labels like these to the app
container, replacing the entrypoint name and certificate resolver to match
your Traefik configuration:

```yaml
labels:
  - "traefik.enable=true"
  - "traefik.http.routers.trackrequests.rule=Host(`trackrequests.gently.org.uk`)"
  - "traefik.http.routers.trackrequests.entrypoints=websecure7000"
  - "traefik.http.routers.trackrequests.tls=true"
  - "traefik.http.routers.trackrequests.tls.certresolver=letsencrypt"
  - "traefik.http.services.trackrequests.loadbalancer.server.port=3000"
```

The `websecure7000` entrypoint must be configured in Traefik with
`address: ":7000"` and made reachable on port 7000. If Traefik is not using
Docker labels, configure the equivalent router rule
`Host(`trackrequests.gently.org.uk`)` with TLS on that entrypoint and a service
whose backend URL is `http://<app-host>:3000`.

### HTTP API

The HTTP API can operate queue actions without a Twitch browser session.
Configure one random token in `track-requests/config.json` under `httpApi`:

```json
"httpApi": {
  "token": "replace-with-a-random-token-of-32-or-more-characters"
}
```

Use one unpredictable token of at least 32 characters and keep it secret.
Anyone holding this token can perform every HTTP API action. It does not
replace Twitch moderator/streamer authorization in the web UI.

Send HTTPS `POST` requests with the token in an `Authorization` header as
`Bearer <token>`. No request body is required:

| Action | Method and path |
| --- | --- |
| Clear the requested track list and viewer limits | `POST /api/reset-tracks` |
| Allow users to request again (queue remains) | `POST /api/allow-new-requests` |
| Disable track selection | `POST /api/disable-track-selection` |
| Enable track selection | `POST /api/enable-track-selection` |
| Disable new requests | `POST /api/disable-requests` |
| Enable new requests | `POST /api/enable-requests` |
| Mark the oldest pending request complete | `POST /api/complete-next` |
| Mark a specific request complete | `POST /api/requests/{requestId}/complete` |

Clearing the track list removes all queued requests, makes those tracks
available again, and clears viewer limits. Allowing new requests clears viewer
limits while keeping the current queue intact.
Disabling track selection hides the picker and rejects requests from both chat
and the web form. Disabling new requests keeps the web interface and picker
visible but rejects new requests from chat and the web form. These switches are
independent and reset to enabled when the server restarts.

The specific request ID is the `id` field on an item returned by
`GET /api/state`. The `complete-next` endpoint completes the next request that
is not already marked completed. Successful calls return JSON with `ok: true`;
completing the next request also returns its `requestId` and `trackName`. If no
request is pending, `complete-next` returns HTTP `409`. Missing or invalid tokens return
HTTP `401`.

For example, send an HTTPS `POST` to the desired endpoint URL with the
`Authorization` header set to `Bearer <token>`. Use the same authorization

### Twitch chat command

The app receives chat through an EventSub `channel.chat.message` subscription
and sends replies through the Helix Send Chat Message API. It uses the persisted
authorization for `chatUser`, or for the channel account if `chatUser` is
empty. It announces when the track list is cleared, when new requests are
allowed, and when a track is requested through the web client. Viewers can
send `!track` without a track name to receive separate private whispers
describing each chat command. The chat account needs `user:manage:whispers` to
send these help messages; the account must also meet Twitch's whisper
requirements. Viewers can request a track with:

```

To troubleshoot a missing help whisper, run the server with `--verbose` and
check for `chat.command_help.requested`, `chat.command_help.whisper.started`,
and `chat.command_help.whisper.api_accepted` in the server logs. Whisper API
errors are logged even without verbose mode. An API-accepted whisper is not
proof of delivery; Twitch may silently drop whispers or users may block
whispers from strangers.text
!track <track name>
!added <track name>
!tracks
!tracksclear
!tracksnewrequests
!trackselectionoff
!trackselectionon
!requestsdisable
!requestsenable
```

`!tracksclear` clears the track list and resets request limits.
`!tracksnewrequests` resets request limits while keeping the current track list.
These commands and the track-selection/request availability switches are
available to channel moderators only. `!trackselectionoff` and
`!trackselectionon` disable and enable the track picker for everyone.
`!requestsdisable` and `!requestsenable` disable and enable new requests without
hiding the rest of the web interface. The switches operate independently.

Channel moderators can also assign a request to a chatter who has been seen in
chat recently:

```text
!track <track name> @username
```

`!tracks` lists the configured circuits in chat. If a name cannot be matched,
the bot suggests this command.

Track matching is case-insensitive, tolerates common small spelling errors,
and recognizes common circuit names: `Silverstone` selects Great Britain,
`Barcelona` selects Catalunya, `Marina Bay` (or `Singaporte`) selects
Singapore, `COTA` selects Texas, and `Madring` selects Madrid. The reverse
circuits also accept names such as `Silverstone Reverse`. A regular viewer can
request one track per round; if they have already requested one, the bot
replies that their request was already used. A track already in the queue is
also rejected with a chat reply. Channel moderators may request multiple
distinct tracks, consistent with the web form. Moderators can assign requests
to chatters seen during the last 30 minutes (up to the 100 most recent); an
assigned request counts toward that chatter's one-request limit. The moderator
assignment checkbox and chatter list are available in the web request form.

Requests, login sessions, and user request limits are held in memory and are
cleared when the server restarts. Twitch account authorizations persist in
`track-requests/.track-request-auth.json`.
