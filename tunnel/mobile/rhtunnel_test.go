package rhtunnel

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/curve25519"

	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun/netstack"

	"reelhouse/tunnel/internal/wg"
)

// fakeReelhouse is a WireGuard endpoint like the server's, with a web server inside the tunnel at 10.78.0.1 that
// echoes what it received.
func fakeReelhouse(t *testing.T, device_ *KeyPair) (endpoint string, serverKey string) {
	t.Helper()
	keys, err := GenerateKeyPair()
	if err != nil {
		t.Fatal(err)
	}
	tunDev, tnet, err := netstack.CreateNetTUN([]netip.Addr{netip.MustParseAddr("10.78.0.1")}, nil, 1420)
	if err != nil {
		t.Fatal(err)
	}
	dev := device.NewDevice(tunDev, conn.NewDefaultBind(), &device.Logger{Verbosef: device.DiscardLogf, Errorf: device.DiscardLogf})
	t.Cleanup(dev.Close)
	priv, _ := wg.KeyHex(keys.PrivateKey)
	peer, err := wg.PeerLines(wg.Peer{PublicKey: device_.PublicKey, Address: "10.78.0.2"})
	if err != nil {
		t.Fatal(err)
	}
	if err := dev.IpcSet(fmt.Sprintf("private_key=%s\nlisten_port=0\n%s", priv, peer)); err != nil {
		t.Fatal(err)
	}
	if err := dev.Up(); err != nil {
		t.Fatal(err)
	}
	ln, err := tnet.ListenTCP(&net.TCPAddr{IP: net.IPv4(10, 78, 0, 1), Port: 80})
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]string{"path": r.URL.RequestURI(), "host": r.Host, "from": r.RemoteAddr})
	})}
	go srv.Serve(ln)
	t.Cleanup(func() { srv.Close() })

	ipc, err := dev.IpcGet()
	if err != nil {
		t.Fatal(err)
	}
	port := ""
	for _, line := range strings.Split(ipc, "\n") {
		if v, ok := strings.CutPrefix(line, "listen_port="); ok {
			port = v
		}
	}
	if port == "" || port == "0" {
		t.Fatalf("no listen port in %q", ipc)
	}
	return "127.0.0.1:" + port, keys.PublicKey
}

func startClient(t *testing.T, keys *KeyPair, endpoint, serverKey string) *Tunnel {
	t.Helper()
	cfg, _ := json.Marshal(map[string]any{
		"privateKey": keys.PrivateKey, "publicKey": serverKey, "endpoint": endpoint, "address": "10.78.0.2", "url": "http://10.78.0.1",
	})
	tun, err := Start(string(cfg))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(tun.Stop)
	return tun
}

func TestRequestsReachReelhouseThroughTheTunnel(t *testing.T) {
	keys, _ := GenerateKeyPair()
	endpoint, serverKey := fakeReelhouse(t, keys)
	tun := startClient(t, keys, endpoint, serverKey)

	if !strings.HasPrefix(tun.ProxyURL(), "http://127.0.0.1:") || strings.HasSuffix(tun.ProxyURL(), "/") {
		t.Fatalf("unexpected local address %q", tun.ProxyURL())
	}
	client := &http.Client{Timeout: 15 * time.Second}
	res, err := client.Get(tun.ProxyURL() + "/api/server?x=1")
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]string
	json.NewDecoder(res.Body).Decode(&got)
	res.Body.Close()
	if res.StatusCode != 200 || got["path"] != "/api/server?x=1" {
		t.Fatalf("status %d, echoed %v", res.StatusCode, got)
	}
	if got["host"] != "10.78.0.1" {
		t.Errorf("Reelhouse should see its tunnel address as the host, saw %q", got["host"])
	}
	if !strings.HasPrefix(got["from"], "10.78.0.2:") {
		t.Errorf("the request should come from the device's tunnel address, came from %q", got["from"])
	}

	var st map[string]any
	json.Unmarshal([]byte(tun.Status()), &st)
	if hs, _ := st["lastHandshake"].(float64); hs == 0 {
		t.Errorf("no handshake reported: %s", tun.Status())
	}
	if err := tun.Rebind(); err != nil {
		t.Errorf("rebind: %v", err)
	}
	if res, err := client.Get(tun.ProxyURL() + "/again"); err != nil || res.StatusCode != 200 {
		t.Errorf("after rebind: %v %v", res, err)
	}
}

func TestOtherAppsCantUseTheTunnelWithoutTheSecretPath(t *testing.T) {
	keys, _ := GenerateKeyPair()
	endpoint, serverKey := fakeReelhouse(t, keys)
	tun := startClient(t, keys, endpoint, serverKey)
	base := tun.ProxyURL()[:strings.LastIndex(tun.ProxyURL(), "/")]
	for _, path := range []string{"/api/server", "/", "/wrongsecret/api/server", tun.ProxyURL()[len(base):] + "x/api/server"} {
		res, err := http.Get(base + path)
		if err != nil {
			t.Fatal(err)
		}
		io.Copy(io.Discard, res.Body)
		res.Body.Close()
		if res.StatusCode != http.StatusNotFound {
			t.Errorf("%s: status %d, want 404", path, res.StatusCode)
		}
	}
}

func TestSecretPrefix(t *testing.T) {
	const prefix = "/0123456789abcdef0123456789abcdef"
	for path, want := range map[string]bool{
		prefix:                  true,
		prefix + "/":            true,
		prefix + "/api/server":  true,
		prefix + "x/api/server": false,
		prefix[:len(prefix)-1]:  false,
		"/0123456789abcdef0123456789abcdee/api/server": false,
		"/": false,
		"":  false,
	} {
		if got := underSecretPrefix(path, prefix); got != want {
			t.Errorf("underSecretPrefix(%q) = %v, want %v", path, got, want)
		}
	}
}

func TestAWrongServerKeyGetsNoAnswer(t *testing.T) {
	keys, _ := GenerateKeyPair()
	endpoint, _ := fakeReelhouse(t, keys)
	other, _ := GenerateKeyPair()
	tun := startClient(t, keys, endpoint, other.PublicKey)
	client := &http.Client{Timeout: 3 * time.Second}
	res, err := client.Get(tun.ProxyURL() + "/api/server")
	if err == nil {
		res.Body.Close()
		if res.StatusCode == 200 {
			t.Fatal("got an answer through a tunnel with the wrong server key")
		}
	}
}

func TestStopClosesTheLocalAddress(t *testing.T) {
	keys, _ := GenerateKeyPair()
	endpoint, serverKey := fakeReelhouse(t, keys)
	tun := startClient(t, keys, endpoint, serverKey)
	tun.Stop()
	tun.Stop() // twice is fine
	client := &http.Client{Timeout: 3 * time.Second}
	if res, err := client.Get(tun.ProxyURL() + "/api/server"); err == nil {
		res.Body.Close()
		t.Fatal("the local address still answers after Stop")
	}
}

func TestKeys(t *testing.T) {
	k, err := GenerateKeyPair()
	if err != nil {
		t.Fatal(err)
	}
	priv, _ := base64.StdEncoding.DecodeString(k.PrivateKey)
	want, _ := curve25519.X25519(priv, curve25519.Basepoint)
	if k.PublicKey != base64.StdEncoding.EncodeToString(want) {
		t.Fatal("public key doesn't match the private key")
	}
	if pub, err := PublicKeyOf(k.PrivateKey); err != nil || pub != k.PublicKey {
		t.Fatalf("PublicKeyOf: %q %v", pub, err)
	}
	if _, err := Start(`{"privateKey":"bad"}`); err == nil {
		t.Fatal("bad settings were accepted")
	}
}
