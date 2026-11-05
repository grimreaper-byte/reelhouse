// tunnel-check: a command-line Reelhouse app tunnel client, for end-to-end tests and as the reference for the
// Android app. It does what the app does: reads a pairing link, brings WireGuard up in userspace (nothing on this
// machine's network changes) and talks to Reelhouse through it.
//
//	tunnel-check [-pair | -own-key] [-endpoint host:port] [-get /api/path] [-download /api/stream/ID] 'reelhouse://pair?d=…'
//
// -pair uses the code through the tunnel, with the key from the pairing (pairing away from home). -own-key is the
// at-home way: make this device's own key, use the code directly at one of the server's addresses (the private
// key never leaves this machine), then bring the tunnel up with what the server answers.
//
// The pairing link can also be given in a file. Output is one JSON object per step.
package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"strings"
	"time"

	"golang.org/x/crypto/curve25519"

	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun/netstack"

	"reelhouse/tunnel/internal/wg"
)

// Pairing is what the QR code in Reelhouse carries (reelhouse://pair?d=<base64url JSON>).
type Pairing struct {
	V         int      `json:"v"`
	Server    string   `json:"server"`
	Code      string   `json:"code"`
	ExpiresAt int64    `json:"expiresAt"`
	URLs      []string `json:"urls"`
	Tunnel    *struct {
		Endpoint     string `json:"endpoint"`
		PublicKey    string `json:"publicKey"`
		PrivateKey   string `json:"privateKey"`
		PresharedKey string `json:"presharedKey"`
		Address      string `json:"address"`
		URL          string `json:"url"`
	} `json:"tunnel"`
}

func parsePairing(text string) (*Pairing, error) {
	text = strings.TrimSpace(text)
	u, err := url.Parse(text)
	if err != nil || u.Scheme != "reelhouse" {
		return nil, errors.New("not a reelhouse:// pairing link")
	}
	raw, err := base64.RawURLEncoding.DecodeString(u.Query().Get("d"))
	if err != nil {
		return nil, fmt.Errorf("pairing data: %w", err)
	}
	var p Pairing
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("pairing data: %w", err)
	}
	return &p, nil
}

func report(step string, fields map[string]any) {
	fields["step"] = step
	json.NewEncoder(os.Stdout).Encode(fields)
}

func die(step string, err error) {
	report(step, map[string]any{"ok": false, "error": err.Error()})
	os.Exit(1)
}

func main() {
	pair := flag.Bool("pair", false, "swap the pairing code for a device sign-in, through the tunnel")
	ownKey := flag.Bool("own-key", false, "make this device's own key and swap the code directly at the server's address")
	direct := flag.String("direct", "", "with -own-key: the address to use (default: the pairing's first address)")
	endpoint := flag.String("endpoint", "", "use this host:port instead of the pairing's WireGuard endpoint")
	get := flag.String("get", "/api/server", "path to fetch through the tunnel")
	download := flag.String("download", "", "path to download through the tunnel (signed in), to measure speed")
	timeout := flag.Duration("timeout", 20*time.Second, "time allowed for each request")
	flag.Parse()
	if flag.NArg() != 1 {
		fmt.Fprintln(os.Stderr, "usage: tunnel-check [flags] 'reelhouse://pair?d=…' | file")
		os.Exit(2)
	}
	arg := flag.Arg(0)
	if !strings.HasPrefix(arg, "reelhouse:") {
		data, err := os.ReadFile(arg)
		if err != nil {
			die("read", err)
		}
		arg = string(data)
	}
	p, err := parsePairing(arg)
	if err != nil {
		die("parse", err)
	}
	if p.Tunnel == nil {
		die("parse", errors.New("this pairing has no tunnel (the app tunnel is off on the server)"))
	}
	token := ""
	if *ownKey {
		token = pairDirectly(p, *direct)
	}
	if *endpoint != "" {
		p.Tunnel.Endpoint = *endpoint
	}

	client, dev, err := up(p)
	if err != nil {
		die("tunnel", err)
	}
	defer dev.Close()
	client.Timeout = *timeout
	base := strings.TrimRight(p.Tunnel.URL, "/")

	started := time.Now()
	body, status, err := request(client, "GET", base+*get, "", nil)
	if err != nil {
		die("get", err)
	}
	report("get", map[string]any{"ok": status == 200, "status": status, "ms": time.Since(started).Milliseconds(), "body": json.RawMessage(orNull(body))})

	if *pair && token == "" {
		host, _ := os.Hostname()
		payload, _ := json.Marshal(map[string]string{"code": p.Code, "device": "tunnel-check (" + host + ")"})
		body, status, err := request(client, "POST", base+"/api/auth/pair", "", payload)
		if err != nil {
			die("pair", err)
		}
		var res struct {
			Token string `json:"token"`
			User  struct {
				Username string `json:"username"`
			} `json:"user"`
			Error string `json:"error"`
		}
		json.Unmarshal(body, &res)
		token = res.Token
		report("pair", map[string]any{"ok": status == 200 && token != "", "status": status, "user": res.User.Username, "error": res.Error})
		if token == "" {
			os.Exit(1)
		}
	}
	if token != "" {
		body, status, err := request(client, "GET", base+"/api/me", token, nil)
		if err != nil {
			die("me", err)
		}
		report("me", map[string]any{"ok": status == 200, "status": status, "body": json.RawMessage(orNull(body))})
	}

	if *download != "" {
		started := time.Now()
		req, _ := http.NewRequest("GET", base+*download, nil)
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		client.Timeout = 0
		res, err := client.Do(req)
		if err != nil {
			die("download", err)
		}
		n, err := io.Copy(io.Discard, res.Body)
		res.Body.Close()
		secs := time.Since(started).Seconds()
		fields := map[string]any{"ok": err == nil && res.StatusCode < 300, "status": res.StatusCode, "bytes": n, "seconds": secs}
		if secs > 0 {
			fields["mbps"] = float64(n) * 8 / secs / 1e6
		}
		if err != nil {
			fields["error"] = err.Error()
		}
		report("download", fields)
	}
}

// pairDirectly makes this device's key pair, swaps the code for a sign-in at one of the server's own addresses
// and takes the tunnel settings from the answer. Returns the sign-in token.
func pairDirectly(p *Pairing, address string) string {
	var priv [32]byte
	if _, err := rand.Read(priv[:]); err != nil {
		die("pair-direct", err)
	}
	priv[0] &= 248
	priv[31] = (priv[31] & 127) | 64
	pub, err := curve25519.X25519(priv[:], curve25519.Basepoint)
	if err != nil {
		die("pair-direct", err)
	}
	if address == "" {
		if len(p.URLs) == 0 {
			die("pair-direct", errors.New("the pairing lists no direct address; give one with -direct"))
		}
		address = p.URLs[0]
	}
	host, _ := os.Hostname()
	payload, _ := json.Marshal(map[string]string{
		"code": p.Code, "device": "tunnel-check (" + host + ")", "publicKey": base64.StdEncoding.EncodeToString(pub),
	})
	body, status, err := request(&http.Client{Timeout: 20 * time.Second}, "POST", strings.TrimRight(address, "/")+"/api/auth/pair", "", payload)
	if err != nil {
		die("pair-direct", err)
	}
	var res struct {
		Token  string `json:"token"`
		Error  string `json:"error"`
		Tunnel *struct {
			Endpoint     string `json:"endpoint"`
			PublicKey    string `json:"publicKey"`
			PresharedKey string `json:"presharedKey"`
			Address      string `json:"address"`
			URL          string `json:"url"`
		} `json:"tunnel"`
		User struct {
			Username string `json:"username"`
		} `json:"user"`
	}
	json.Unmarshal(body, &res)
	ok := status == 200 && res.Token != "" && res.Tunnel != nil
	report("pair-direct", map[string]any{"ok": ok, "status": status, "address": address, "user": res.User.Username, "error": res.Error})
	if !ok {
		os.Exit(1)
	}
	t := p.Tunnel
	t.PrivateKey = base64.StdEncoding.EncodeToString(priv[:])
	t.PublicKey, t.PresharedKey, t.Address, t.URL = res.Tunnel.PublicKey, res.Tunnel.PresharedKey, res.Tunnel.Address, res.Tunnel.URL
	if res.Tunnel.Endpoint != "" {
		t.Endpoint = res.Tunnel.Endpoint
	}
	return res.Token
}

// up brings the tunnel up inside this process and returns an HTTP client whose connections go through it.
func up(p *Pairing) (*http.Client, *device.Device, error) {
	t := p.Tunnel
	addr, err := netip.ParseAddr(t.Address)
	if err != nil {
		return nil, nil, fmt.Errorf("tunnel address: %w", err)
	}
	server, err := url.Parse(t.URL)
	if err != nil {
		return nil, nil, fmt.Errorf("tunnel URL: %w", err)
	}
	ep, err := net.ResolveUDPAddr("udp", t.Endpoint)
	if err != nil {
		return nil, nil, fmt.Errorf("endpoint %q: %w", t.Endpoint, err)
	}
	priv, err := wg.KeyHex(t.PrivateKey)
	if err != nil {
		return nil, nil, err
	}
	pub, err := wg.KeyHex(t.PublicKey)
	if err != nil {
		return nil, nil, err
	}
	psk, err := wg.KeyHex(t.PresharedKey)
	if err != nil {
		return nil, nil, err
	}
	tunDev, tnet, err := netstack.CreateNetTUN([]netip.Addr{addr}, nil, 1420)
	if err != nil {
		return nil, nil, err
	}
	dev := device.NewDevice(tunDev, conn.NewDefaultBind(), &device.Logger{Verbosef: device.DiscardLogf, Errorf: device.DiscardLogf})
	config := fmt.Sprintf("private_key=%s\npublic_key=%s\npreshared_key=%s\nendpoint=%s\nallowed_ip=%s/32\npersistent_keepalive_interval=25\n",
		priv, pub, psk, ep.String(), server.Hostname())
	if err := dev.IpcSet(config); err != nil {
		dev.Close()
		return nil, nil, err
	}
	if err := dev.Up(); err != nil {
		dev.Close()
		return nil, nil, err
	}
	transport := &http.Transport{
		Proxy: nil,
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			return tnet.DialContext(ctx, network, address)
		},
	}
	return &http.Client{Transport: transport}, dev, nil
}

func request(client *http.Client, method, target, token string, body []byte) ([]byte, int, error) {
	req, err := http.NewRequest(method, target, bytes.NewReader(body))
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("X-Requested-With", "reelhouse")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	return data, res.StatusCode, err
}

func orNull(body []byte) []byte {
	if json.Valid(body) {
		return body
	}
	quoted, _ := json.Marshal(string(body))
	return quoted
}
