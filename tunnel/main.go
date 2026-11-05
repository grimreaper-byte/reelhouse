// reelhouse-tunnel: the app tunnel endpoint. A WireGuard server that runs entirely in userspace (wireguard-go with
// gVisor's network stack), so it needs no admin rights, kernel module or network setup on the machine. Inside the
// tunnel it answers HTTP only, and passes each request to Reelhouse tagged with the device's tunnel address.
// Nothing else on the machine can be reached through it.
//
// Reelhouse starts it and talks to it over stdin/stdout, one JSON object per line:
//
//	in:  the Config first, then {"op":"peers","peers":[...]} to replace the device list, or {"op":"status"}
//	out: {"event":"ready"}, {"event":"status","peers":[...]}, {"event":"log","message":...}, {"event":"error",...}
//
// It exits when stdin closes, so it never outlives Reelhouse.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/netip"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun/netstack"

	"reelhouse/tunnel/internal/wg"
)

// Config is the first line Reelhouse sends.
type Config struct {
	PrivateKey string    `json:"privateKey"` // the endpoint's own key (base64)
	ListenPort int       `json:"listenPort"` // UDP port WireGuard answers on
	Address    string    `json:"address"`    // the endpoint's address inside the tunnel, e.g. 10.78.0.1
	HTTPPorts  []int     `json:"httpPorts"`  // ports answered inside the tunnel (80 and Reelhouse's own)
	Target     string    `json:"target"`     // where requests go, e.g. http://127.0.0.1:8484
	Secret     string    `json:"secret"`     // proves to Reelhouse that a request came through the tunnel
	MTU        int       `json:"mtu"`
	Peers      []wg.Peer `json:"peers"`
}

type command struct {
	Op    string    `json:"op"`
	Peers []wg.Peer `json:"peers"`
}

var (
	outMu sync.Mutex
	out   = json.NewEncoder(os.Stdout)
)

func emit(event string, fields map[string]any) {
	if fields == nil {
		fields = map[string]any{}
	}
	fields["event"] = event
	outMu.Lock()
	defer outMu.Unlock()
	out.Encode(fields)
}

func fail(format string, args ...any) {
	emit("error", map[string]any{"message": fmt.Sprintf(format, args...)})
	os.Exit(1)
}

func main() {
	in := bufio.NewScanner(os.Stdin)
	in.Buffer(make([]byte, 64*1024), 16*1024*1024)
	if !in.Scan() {
		fail("no configuration on stdin")
	}
	var cfg Config
	if err := json.Unmarshal(in.Bytes(), &cfg); err != nil {
		fail("bad configuration: %v", err)
	}
	t, err := start(cfg)
	if err != nil {
		fail("%v", err)
	}
	emit("ready", map[string]any{"listenPort": cfg.ListenPort, "address": cfg.Address})

	for in.Scan() {
		var cmd command
		if err := json.Unmarshal(in.Bytes(), &cmd); err != nil {
			emit("log", map[string]any{"message": "ignored a bad command: " + err.Error()})
			continue
		}
		switch cmd.Op {
		case "peers":
			if err := t.setPeers(cmd.Peers); err != nil {
				emit("log", map[string]any{"message": "peer update failed: " + err.Error()})
			}
			t.reportStatus()
		case "status":
			t.reportStatus()
		}
	}
	// stdin closed: Reelhouse stopped (or died). Go too.
	t.dev.Close()
}

type tunnel struct {
	dev   *device.Device
	mu    sync.Mutex
	peers map[string]wg.Peer // by public key
}

func start(cfg Config) (*tunnel, error) {
	addr, err := netip.ParseAddr(cfg.Address)
	if err != nil || !addr.Is4() {
		return nil, fmt.Errorf("not an IPv4 tunnel address: %q", cfg.Address)
	}
	target, err := url.Parse(cfg.Target)
	if err != nil || target.Host == "" {
		return nil, fmt.Errorf("bad target %q", cfg.Target)
	}
	if cfg.Secret == "" || len(cfg.HTTPPorts) == 0 {
		return nil, errors.New("a secret and at least one HTTP port are needed")
	}
	priv, err := wg.KeyHex(cfg.PrivateKey)
	if err != nil {
		return nil, err
	}
	mtu := cfg.MTU
	if mtu == 0 {
		mtu = 1420
	}

	tunDev, tnet, err := netstack.CreateNetTUN([]netip.Addr{addr}, nil, mtu)
	if err != nil {
		return nil, fmt.Errorf("network stack: %w", err)
	}
	logger := &device.Logger{
		Verbosef: device.DiscardLogf,
		Errorf: func(format string, args ...any) {
			emit("log", map[string]any{"message": fmt.Sprintf(format, args...)})
		},
	}
	dev := device.NewDevice(tunDev, conn.NewDefaultBind(), logger)
	if err := dev.IpcSet(fmt.Sprintf("private_key=%s\nlisten_port=%d\n", priv, cfg.ListenPort)); err != nil {
		dev.Close()
		return nil, fmt.Errorf("WireGuard setup (is UDP port %d free?): %w", cfg.ListenPort, err)
	}
	t := &tunnel{dev: dev, peers: map[string]wg.Peer{}}
	if err := t.setPeers(cfg.Peers); err != nil {
		dev.Close()
		return nil, err
	}
	if err := dev.Up(); err != nil {
		dev.Close()
		return nil, fmt.Errorf("WireGuard start: %w", err)
	}

	proxy := newProxy(target, cfg.Secret)
	server := &http.Server{Handler: proxy, ReadHeaderTimeout: 30 * time.Second, IdleTimeout: 2 * time.Minute}
	for _, port := range cfg.HTTPPorts {
		ln, err := tnet.ListenTCP(&net.TCPAddr{IP: addr.AsSlice(), Port: port})
		if err != nil {
			dev.Close()
			return nil, fmt.Errorf("listen on %s:%d in the tunnel: %w", addr, port, err)
		}
		go server.Serve(ln)
	}
	return t, nil
}

// newProxy passes requests on to Reelhouse unchanged except for two headers it sets itself (replacing any a
// device sent): the shared secret, and the device's tunnel address, which Reelhouse uses as the client's address.
func newProxy(target *url.URL, secret string) *httputil.ReverseProxy {
	return &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(target)
			pr.Out.Host = pr.In.Host
			peer, _, _ := strings.Cut(pr.In.RemoteAddr, ":")
			pr.Out.Header.Set("X-Reelhouse-Tunnel", secret)
			pr.Out.Header.Set("X-Reelhouse-Tunnel-Peer", peer)
		},
		// Streams, live updates and long downloads go out as they arrive.
		FlushInterval: -1,
		Transport: &http.Transport{
			Proxy:               nil,
			DialContext:         (&net.Dialer{Timeout: 10 * time.Second}).DialContext,
			DisableCompression:  true,
			MaxIdleConnsPerHost: 32,
			IdleConnTimeout:     90 * time.Second,
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			if errors.Is(err, context.Canceled) {
				return // the device went away mid-request
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadGateway)
			fmt.Fprintf(w, `{"error":"Reelhouse is not answering behind the tunnel"}`)
		},
	}
}

// setPeers makes the device list exactly `peers`: removes the ones that are gone and adds or updates the rest,
// leaving unchanged peers (and their connections) alone.
func (t *tunnel) setPeers(peers []wg.Peer) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	want := map[string]wg.Peer{}
	adds := map[string]string{}
	for _, p := range peers {
		lines, err := wg.PeerLines(p)
		if err != nil {
			// One bad entry must not keep every other device out (or stop the endpoint from starting).
			emit("log", map[string]any{"message": "skipped a device: " + err.Error()})
			continue
		}
		want[p.PublicKey] = p
		adds[p.PublicKey] = lines
	}
	var b strings.Builder
	for key := range t.peers {
		if _, ok := want[key]; !ok {
			lines, err := wg.RemoveLines(key)
			if err != nil {
				return err
			}
			b.WriteString(lines)
		}
	}
	for key, p := range want {
		if old, ok := t.peers[key]; ok && old == p {
			continue
		}
		b.WriteString(adds[key])
	}
	if b.Len() > 0 {
		if err := t.dev.IpcSet(b.String()); err != nil {
			return err
		}
	}
	t.peers = want
	return nil
}

func (t *tunnel) reportStatus() {
	peers, err := wg.Status(t.dev)
	if err != nil {
		emit("log", map[string]any{"message": "status: " + err.Error()})
		return
	}
	if peers == nil {
		peers = []wg.PeerStatus{}
	}
	emit("status", map[string]any{"peers": peers})
}
