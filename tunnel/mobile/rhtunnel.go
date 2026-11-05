// Package rhtunnel is the Reelhouse app's end of the app tunnel, built into the Android app with gomobile
// (see tunnel/README.md).
//
// It brings a WireGuard tunnel up entirely inside the app — wireguard-go with gVisor's network stack, so there is
// no VPN service and nothing else on the phone goes through it — and offers Reelhouse to the rest of the app as a
// local web address, http://127.0.0.1:<port>/<secret>/. Requests there are passed to Reelhouse inside the tunnel,
// so the app's HTTP client, image loader and video player need nothing tunnel-specific. The random path secret
// keeps other apps on the phone from using the tunnel.
package rhtunnel

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/netip"
	"net/url"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/curve25519"

	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun/netstack"

	"reelhouse/tunnel/internal/wg"
)

// KeyPair is a WireGuard key pair in base64, the form Reelhouse and .conf files use.
type KeyPair struct {
	PrivateKey string
	PublicKey  string
}

// GenerateKeyPair makes this device's own key pair, so that pairing at home never sends a private key anywhere.
func GenerateKeyPair() (*KeyPair, error) {
	var priv [32]byte
	if _, err := rand.Read(priv[:]); err != nil {
		return nil, err
	}
	priv[0] &= 248
	priv[31] = (priv[31] & 127) | 64
	pub, err := curve25519.X25519(priv[:], curve25519.Basepoint)
	if err != nil {
		return nil, err
	}
	return &KeyPair{PrivateKey: base64.StdEncoding.EncodeToString(priv[:]), PublicKey: base64.StdEncoding.EncodeToString(pub)}, nil
}

// PublicKeyOf derives the public key that goes with a private key.
func PublicKeyOf(privateKey string) (string, error) {
	h, err := wg.KeyHex(privateKey)
	if err != nil {
		return "", err
	}
	raw, _ := hex.DecodeString(h)
	pub, err := curve25519.X25519(raw, curve25519.Basepoint)
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(pub), nil
}

// config is what Start takes, as JSON. The fields match Reelhouse's tunnel settings (pairing QR code,
// POST /api/auth/pair, GET /api/me/tunnel) plus this device's private key.
type config struct {
	PrivateKey   string `json:"privateKey"`   // this device's key
	PublicKey    string `json:"publicKey"`    // the Reelhouse endpoint's key
	PresharedKey string `json:"presharedKey"` // optional
	Endpoint     string `json:"endpoint"`     // host:port of the endpoint
	Address      string `json:"address"`      // this device's address inside the tunnel
	URL          string `json:"url"`          // Reelhouse inside the tunnel, e.g. http://10.78.0.1
	MTU          int    `json:"mtu"`
}

// Tunnel is a running tunnel and its local web address.
type Tunnel struct {
	dev       *device.Device
	server    *http.Server
	proxyURL  string
	serverKey string // hex

	mu        sync.Mutex
	lastError string
	stopped   bool
}

// Start brings the tunnel up from a JSON configuration (see config) and starts the local web address.
// Nothing is sent until the first request; WireGuard's handshake happens then.
func Start(configJSON string) (*Tunnel, error) {
	var c config
	if err := json.Unmarshal([]byte(configJSON), &c); err != nil {
		return nil, fmt.Errorf("tunnel settings: %w", err)
	}
	addr, err := netip.ParseAddr(c.Address)
	if err != nil || !addr.Is4() {
		return nil, fmt.Errorf("not an IPv4 tunnel address: %q", c.Address)
	}
	target, err := url.Parse(c.URL)
	if err != nil || target.Hostname() == "" {
		return nil, fmt.Errorf("bad Reelhouse address in the tunnel: %q", c.URL)
	}
	serverIP, err := netip.ParseAddr(target.Hostname())
	if err != nil || !serverIP.Is4() {
		return nil, fmt.Errorf("Reelhouse's tunnel address must be an IPv4 address: %q", c.URL)
	}
	priv, err := wg.KeyHex(c.PrivateKey)
	if err != nil {
		return nil, fmt.Errorf("device key: %w", err)
	}
	pub, err := wg.KeyHex(c.PublicKey)
	if err != nil {
		return nil, fmt.Errorf("Reelhouse's key: %w", err)
	}
	ep, err := resolveEndpoint(c.Endpoint)
	if err != nil {
		return nil, err
	}
	mtu := c.MTU
	if mtu == 0 {
		mtu = 1280 // safe on mobile networks, which often carry less than 1420
	}

	t := &Tunnel{serverKey: pub}
	tunDev, tnet, err := netstack.CreateNetTUN([]netip.Addr{addr}, nil, mtu)
	if err != nil {
		return nil, fmt.Errorf("network stack: %w", err)
	}
	logger := &device.Logger{
		Verbosef: device.DiscardLogf,
		Errorf: func(format string, args ...any) {
			t.mu.Lock()
			t.lastError = fmt.Sprintf(format, args...)
			t.mu.Unlock()
		},
	}
	t.dev = device.NewDevice(tunDev, conn.NewDefaultBind(), logger)
	var b strings.Builder
	fmt.Fprintf(&b, "private_key=%s\npublic_key=%s\n", priv, pub)
	if c.PresharedKey != "" {
		psk, err := wg.KeyHex(c.PresharedKey)
		if err != nil {
			t.dev.Close()
			return nil, fmt.Errorf("preshared key: %w", err)
		}
		fmt.Fprintf(&b, "preshared_key=%s\n", psk)
	}
	// Only Reelhouse's own address goes through the tunnel; keepalives hold the way open through home routers.
	fmt.Fprintf(&b, "endpoint=%s\nallowed_ip=%s/32\npersistent_keepalive_interval=25\n", ep, serverIP)
	if err := t.dev.IpcSet(b.String()); err != nil {
		t.dev.Close()
		return nil, fmt.Errorf("WireGuard setup: %w", err)
	}
	if err := t.dev.Up(); err != nil {
		t.dev.Close()
		return nil, fmt.Errorf("WireGuard start: %w", err)
	}

	secret := make([]byte, 16)
	if _, err := rand.Read(secret); err != nil {
		t.dev.Close()
		return nil, err
	}
	prefix := "/" + hex.EncodeToString(secret)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.dev.Close()
		return nil, fmt.Errorf("local address: %w", err)
	}
	t.proxyURL = "http://" + ln.Addr().String() + prefix
	t.server = &http.Server{Handler: newProxy(target, prefix, tnet), ReadHeaderTimeout: 30 * time.Second}
	go t.server.Serve(ln)
	return t, nil
}

func resolveEndpoint(endpoint string) (string, error) {
	host, port, err := net.SplitHostPort(strings.TrimSpace(endpoint))
	if err != nil {
		return "", fmt.Errorf("endpoint %q: %w", endpoint, err)
	}
	ep, err := net.ResolveUDPAddr("udp", net.JoinHostPort(host, port))
	if err != nil {
		return "", fmt.Errorf("can't find %s: %w", host, err)
	}
	return ep.String(), nil
}

// newProxy passes requests under the secret prefix to Reelhouse inside the tunnel, with the prefix removed.
func newProxy(target *url.URL, prefix string, tnet *netstack.Net) http.Handler {
	proxy := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.Out.URL.Path = strings.TrimPrefix(pr.Out.URL.Path, prefix)
			pr.Out.URL.RawPath = ""
			pr.SetURL(target)
		},
		// Video, live updates and downloads go out as they arrive.
		FlushInterval: -1,
		Transport: &http.Transport{
			Proxy: nil,
			DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
				return tnet.DialContext(ctx, network, address)
			},
			DisableCompression:    true,
			MaxIdleConnsPerHost:   16,
			IdleConnTimeout:       60 * time.Second,
			ResponseHeaderTimeout: 0, // Reelhouse may take a while to start a conversion
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			if errors.Is(err, context.Canceled) {
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadGateway)
			msg, _ := json.Marshal(map[string]string{"error": "Reelhouse can't be reached through the tunnel: " + err.Error()})
			w.Write(msg)
		},
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !underSecretPrefix(r.URL.Path, prefix) {
			http.NotFound(w, r)
			return
		}
		proxy.ServeHTTP(w, r)
	})
}

// underSecretPrefix reports whether path is the secret prefix or below it. The secret is compared in constant
// time, so another app on the phone can't work it out a character at a time from how fast wrong guesses fail.
func underSecretPrefix(path, prefix string) bool {
	if len(path) < len(prefix) || subtle.ConstantTimeCompare([]byte(path[:len(prefix)]), []byte(prefix)) != 1 {
		return false
	}
	return len(path) == len(prefix) || path[len(prefix)] == '/'
}

// ProxyURL is Reelhouse's local web address, without a trailing slash: add API paths such as /api/server to it.
func (t *Tunnel) ProxyURL() string {
	return t.proxyURL
}

// SetEndpoint points the tunnel at a new endpoint address (host:port), e.g. after the home IP changed.
func (t *Tunnel) SetEndpoint(endpoint string) error {
	ep, err := resolveEndpoint(endpoint)
	if err != nil {
		return err
	}
	return t.dev.IpcSet(fmt.Sprintf("public_key=%s\nupdate_only=true\nendpoint=%s\n", t.serverKey, ep))
}

// Rebind opens a fresh UDP socket, for after the phone changed networks (Wi-Fi to mobile data and back).
func (t *Tunnel) Rebind() error {
	return t.dev.BindUpdate()
}

// Status reports the tunnel as JSON: {"lastHandshake": unix seconds or 0, "rxBytes", "txBytes", "endpoint",
// "lastError"}.
func (t *Tunnel) Status() string {
	out := map[string]any{"lastHandshake": 0, "rxBytes": 0, "txBytes": 0}
	if peers, err := wg.Status(t.dev); err == nil && len(peers) > 0 {
		p := peers[0]
		out["lastHandshake"], out["rxBytes"], out["txBytes"], out["endpoint"] = p.LastHandshake, p.RxBytes, p.TxBytes, p.Endpoint
	}
	t.mu.Lock()
	if t.lastError != "" {
		out["lastError"] = t.lastError
	}
	t.mu.Unlock()
	data, _ := json.Marshal(out)
	return string(data)
}

// Stop closes the local web address and the tunnel. Safe to call more than once.
func (t *Tunnel) Stop() {
	t.mu.Lock()
	if t.stopped {
		t.mu.Unlock()
		return
	}
	t.stopped = true
	t.mu.Unlock()
	t.server.Close()
	t.dev.Close()
}
