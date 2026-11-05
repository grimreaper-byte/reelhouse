package main

import (
	"crypto/rand"
	"encoding/base64"
	"testing"

	"golang.org/x/crypto/curve25519"
	"golang.zx2c4.com/wireguard/device"

	"reelhouse/tunnel/internal/wg"
)

func newKey(t *testing.T) (priv, pub string) {
	t.Helper()
	var k [32]byte
	if _, err := rand.Read(k[:]); err != nil {
		t.Fatal(err)
	}
	k[0] &= 248
	k[31] = (k[31] & 127) | 64
	p, err := curve25519.X25519(k[:], curve25519.Basepoint)
	if err != nil {
		t.Fatal(err)
	}
	return base64.StdEncoding.EncodeToString(k[:]), base64.StdEncoding.EncodeToString(p)
}

func mustKey(t *testing.T, b64 string) device.NoisePublicKey {
	t.Helper()
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		t.Fatal(err)
	}
	var k device.NoisePublicKey
	copy(k[:], raw)
	return k
}

func keys(t *testing.T, tun *tunnel) []string {
	t.Helper()
	status, err := wg.Status(tun.dev)
	if err != nil {
		t.Fatal(err)
	}
	out := []string{}
	for _, s := range status {
		out = append(out, s.PublicKey)
	}
	return out
}

func TestOneBadDeviceDoesNotStopTheEndpoint(t *testing.T) {
	serverKey, _ := newKey(t)
	_, phone := newKey(t)
	_, tablet := newKey(t)
	tun, err := start(Config{
		PrivateKey: serverKey, ListenPort: 0, Address: "10.78.0.1", HTTPPorts: []int{80},
		Target: "http://127.0.0.1:1", Secret: "s",
		Peers: []wg.Peer{
			{PublicKey: phone, Address: "10.78.0.2"},
			{PublicKey: "not-a-key", Address: "10.78.0.3"},
			{PublicKey: tablet, Address: "not-an-address"},
		},
	})
	if err != nil {
		t.Fatalf("the endpoint should start with the good device: %v", err)
	}
	defer tun.dev.Close()
	if got := keys(t, tun); len(got) != 1 || got[0] != phone {
		t.Fatalf("devices = %v, want only the phone", got)
	}

	// Later lists work around bad entries too, and removals still happen.
	if err := tun.setPeers([]wg.Peer{{PublicKey: tablet, Address: "10.78.0.4"}, {PublicKey: "still bad", Address: "10.78.0.5"}}); err != nil {
		t.Fatal(err)
	}
	if got := keys(t, tun); len(got) != 1 || got[0] != tablet {
		t.Fatalf("devices = %v, want only the tablet", got)
	}
}

func TestUnchangedDevicesAreLeftAlone(t *testing.T) {
	serverKey, _ := newKey(t)
	_, phone := newKey(t)
	tun, err := start(Config{PrivateKey: serverKey, Address: "10.78.0.1", HTTPPorts: []int{80}, Target: "http://127.0.0.1:1", Secret: "s",
		Peers: []wg.Peer{{PublicKey: phone, Address: "10.78.0.2"}}})
	if err != nil {
		t.Fatal(err)
	}
	defer tun.dev.Close()
	before := tun.dev.LookupPeer(mustKey(t, phone))
	if err := tun.setPeers([]wg.Peer{{PublicKey: phone, Address: "10.78.0.2"}}); err != nil {
		t.Fatal(err)
	}
	if after := tun.dev.LookupPeer(mustKey(t, phone)); after != before {
		t.Fatal("an unchanged device was replaced (its connection would drop)")
	}
}
