// Package wg holds the WireGuard pieces shared by the app tunnel endpoint and the command-line client: keys in
// WireGuard's text form, and the userspace configuration ("UAPI") lines wireguard-go is set up with.
package wg

import (
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/netip"
	"strings"

	"golang.zx2c4.com/wireguard/device"
)

// KeyHex turns a base64 key (as in .conf files) into the hex form the UAPI expects.
func KeyHex(b64 string) (string, error) {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(b64))
	if err != nil || len(raw) != 32 {
		return "", fmt.Errorf("not a WireGuard key: %q", b64)
	}
	return hex.EncodeToString(raw), nil
}

// KeyBase64 is the reverse of KeyHex.
func KeyBase64(hexKey string) string {
	raw, err := hex.DecodeString(hexKey)
	if err != nil {
		return ""
	}
	return base64.StdEncoding.EncodeToString(raw)
}

// Peer is one device allowed through the tunnel: its key, an optional preshared key and its tunnel address.
type Peer struct {
	PublicKey    string `json:"publicKey"`
	PresharedKey string `json:"presharedKey,omitempty"`
	Address      string `json:"address"`
}

// PeerLines are the UAPI lines that add or update a peer that may only use its own tunnel address.
func PeerLines(p Peer) (string, error) {
	pub, err := KeyHex(p.PublicKey)
	if err != nil {
		return "", err
	}
	addr, err := netip.ParseAddr(p.Address)
	if err != nil || !addr.Is4() {
		return "", fmt.Errorf("not an IPv4 tunnel address: %q", p.Address)
	}
	var b strings.Builder
	fmt.Fprintf(&b, "public_key=%s\n", pub)
	if p.PresharedKey != "" {
		psk, err := KeyHex(p.PresharedKey)
		if err != nil {
			return "", err
		}
		fmt.Fprintf(&b, "preshared_key=%s\n", psk)
	}
	fmt.Fprintf(&b, "replace_allowed_ips=true\nallowed_ip=%s/32\n", addr)
	return b.String(), nil
}

// RemoveLines are the UAPI lines that remove a peer.
func RemoveLines(publicKey string) (string, error) {
	pub, err := KeyHex(publicKey)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("public_key=%s\nremove=true\n", pub), nil
}

// PeerStatus is what the device reports about a peer.
type PeerStatus struct {
	PublicKey     string `json:"publicKey"`
	LastHandshake int64  `json:"lastHandshake"` // unix seconds, 0 = never
	Endpoint      string `json:"endpoint,omitempty"`
	RxBytes       int64  `json:"rxBytes"`
	TxBytes       int64  `json:"txBytes"`
}

// Status reads every peer's handshake time, endpoint and traffic from the device.
func Status(dev *device.Device) ([]PeerStatus, error) {
	text, err := dev.IpcGet()
	if err != nil {
		return nil, err
	}
	var out []PeerStatus
	var cur *PeerStatus
	for _, line := range strings.Split(text, "\n") {
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		switch key {
		case "public_key":
			out = append(out, PeerStatus{PublicKey: KeyBase64(value)})
			cur = &out[len(out)-1]
		case "last_handshake_time_sec":
			if cur != nil {
				fmt.Sscan(value, &cur.LastHandshake)
			}
		case "endpoint":
			if cur != nil {
				cur.Endpoint = value
			}
		case "rx_bytes":
			if cur != nil {
				fmt.Sscan(value, &cur.RxBytes)
			}
		case "tx_bytes":
			if cur != nil {
				fmt.Sscan(value, &cur.TxBytes)
			}
		}
	}
	return out, nil
}
