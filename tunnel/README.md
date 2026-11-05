# Reelhouse app tunnel

A WireGuard endpoint built into Reelhouse, for the Reelhouse app. The app carries its own WireGuard client, so
only the app's traffic goes through the tunnel: no VPN app on the phone, no VPN slot taken, and other VPNs keep
working. On the server, nothing is installed or reconfigured, devices are added and removed live, and the only
thing reachable through the tunnel is Reelhouse itself.

This folder holds two Go programs, both built on [wireguard-go](https://git.zx2c4.com/wireguard-go) in userspace
with gVisor's network stack, so neither touches the machine's network setup or needs admin rights:

| Program | |
| --- | --- |
| `reelhouse-tunnel` (`main.go`) | The endpoint. Reelhouse starts it, gives it its key and the device list, and stops it. Inside the tunnel it answers HTTP on ports 80 and Reelhouse's own port and passes requests to Reelhouse. |
| `tunnel-check` (`cmd/tunnel-check`) | A command-line client: pairs and calls Reelhouse through the tunnel the way the Android app does. Used by the end-to-end tests. |

`mobile/` is the app's end of the tunnel, a library the Android app builds in with gomobile (see below).

Turn the tunnel on in **Settings → Remote access → Reelhouse app tunnel**, forward its UDP port (51821) on the
router, then pair phones from **Your account → Apps and devices**.

## Building

The Docker image builds the endpoint itself (a Go stage in the `Dockerfile`), so a Docker install needs nothing
extra. For a Windows or Linux install, build it with Go 1.23 or newer:

```bash
cd tunnel
go build -trimpath -ldflags="-s -w" -o bin/reelhouse-tunnel .            # Linux / macOS
go build -trimpath -ldflags="-s -w" -o bin/reelhouse-tunnel.exe .        # Windows
go build -trimpath -ldflags="-s -w" -o bin/tunnel-check ./cmd/tunnel-check
```

Without Go, the same works in a throwaway container (from the repository root):

```bash
docker run --rm -v "$PWD/tunnel:/src" -w /src golang:1.25 sh -c 'CGO_ENABLED=0 GOOS=windows go build -o bin/reelhouse-tunnel.exe . && CGO_ENABLED=0 go build -o bin/tunnel-check ./cmd/tunnel-check'
```

Reelhouse looks for the endpoint at `tunnel/bin/reelhouse-tunnel` (`.exe` on Windows), or wherever
`REELHOUSE_TUNNEL_BIN` points. `npm test` runs a full end-to-end test through the real tunnel when both programs
are in `tunnel/bin`, and skips it otherwise.

## The app's library (`mobile/`)

Package `rhtunnel` runs the device's end of the tunnel inside the Android app's process:
- `GenerateKeyPair()` makes the device's own key pair.
- `Start(configJSON)` brings the tunnel up from the device's tunnel settings plus its private key, and starts a
  local HTTP proxy at `ProxyURL()` = `http://127.0.0.1:<port>/<random secret>`. Requests under that address go to
  Reelhouse inside the tunnel, so the app's HTTP client, image loader and video player just use it as Reelhouse's
  address. Without the secret path the proxy answers 404, so other apps on the phone can't use the tunnel.
- `Status()`, `Rebind()` (after a network change), `SetEndpoint()` (after the home address changed) and `Stop()`
  manage it after that.

It's a Go module of its own, because gomobile needs a newer Go (1.26) than the server's endpoint does. It shares
the parent module's WireGuard helpers through a `replace`. `go test ./...` in `mobile/` does a real WireGuard
handshake against an in-process endpoint. The Android build (`android/`) runs `gomobile bind` itself.

## How it fits together

- **Keys.** The endpoint's key is in Reelhouse's settings (`appTunnel`). Each paired device has its own key in
  the `tunnel_peers` table, tied to that device's sign-in: signing the device out, changing the password or
  deleting the user removes the key, and the endpoint stops answering it at once.
- **Pairing.** "Pair the Reelhouse app" makes a one-time code (10 minutes, single use) and a QR code holding
  `reelhouse://pair?d=<base64url JSON>`:

  ```json
  { "v": 1, "server": "…", "id": "<server id>", "code": "ABCD-2345", "expiresAt": 1792…,
    "urls": ["http://192.168.1.20:8484", "https://home.example.net:8443"],
    "tunnel": { "endpoint": "home.example.net:51821", "publicKey": "<endpoint key>", "privateKey": "<device key>",
                "presharedKey": "…", "address": "10.78.0.2", "url": "http://10.78.0.1" } }
  ```

  The app swaps the code for its own sign-in with `POST /api/auth/pair {code, device, publicKey?}`:
  - **At home**, it makes its own key pair and sends the public key, directly to one of `urls`, but only where
    `GET /api/server` answers with the code's `id` (away from home, a home address can be another device). Its
    private key never leaves the phone, and the one in the QR code stops working.
  - **Away**, it brings the tunnel up with the QR code's key and sends the code through the tunnel.

  The answer carries the sign-in token and the device's tunnel settings, minus the private key. Afterwards the
  app asks `GET /api/me/tunnel` whenever it reaches Reelhouse: the public address (or port) can change after
  pairing, e.g. when the home IP changes without dynamic DNS. Each user can have three pairings open at a time; a
  fourth cancels the oldest. `GET /api/server` includes a stable server `id`, which the app compares before it
  trusts a home address. Signing out (`POST /api/auth/logout`) ends the sign-in at once and removes the tunnel key
  1.5 s later, so the answer still gets back to an app signing out through its own tunnel.
- **Requests.** The endpoint passes each request to Reelhouse with `X-Reelhouse-Tunnel` (a secret that changes on
  every start) and `X-Reelhouse-Tunnel-Peer` (the device's tunnel address). Only requests from this machine that
  carry the secret count as tunnelled. The device's tunnel address is then the client's address, and the device
  counts as away from home (remote quality defaults apply).
- **Control.** Reelhouse talks to the endpoint over stdin/stdout, one JSON object per line: the configuration
  first, then `{"op":"peers","peers":[…]}` to replace the device list (unchanged devices keep their connection) or
  `{"op":"status"}`. The endpoint answers with `ready`, `status`, `log` and `error` events, and exits when its input
  closes, so it never outlives Reelhouse.
