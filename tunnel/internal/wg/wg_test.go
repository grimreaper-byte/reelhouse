package wg

import (
	"strings"
	"testing"
)

const key = "yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk="

func TestKeysConvertBothWays(t *testing.T) {
	hexKey, err := KeyHex(key)
	if err != nil {
		t.Fatal(err)
	}
	if len(hexKey) != 64 || KeyBase64(hexKey) != key {
		t.Fatalf("round trip gave %q / %q", hexKey, KeyBase64(hexKey))
	}
	for _, bad := range []string{"", "abc", "AAAA", key[:40] + "=="} {
		if _, err := KeyHex(bad); err == nil {
			t.Errorf("KeyHex(%q) should fail", bad)
		}
	}
}

func TestPeerLinesAllowOnlyTheDevicesOwnAddress(t *testing.T) {
	lines, err := PeerLines(Peer{PublicKey: key, PresharedKey: key, Address: "10.78.0.2"})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"public_key=", "preshared_key=", "replace_allowed_ips=true", "allowed_ip=10.78.0.2/32"} {
		if !strings.Contains(lines, want) {
			t.Errorf("missing %q in\n%s", want, lines)
		}
	}
	for _, addr := range []string{"", "10.78.0.0/24", "fd00::2", "nonsense"} {
		if _, err := PeerLines(Peer{PublicKey: key, Address: addr}); err == nil {
			t.Errorf("address %q should be refused", addr)
		}
	}
}
