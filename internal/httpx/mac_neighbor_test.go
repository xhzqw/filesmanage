package httpx

import (
	"strings"
	"testing"
)

func TestMACFromARPRequiresExactReachableNeighbor(t *testing.T) {
	arp := "IP address HW type Flags HW address Mask Device\n" +
		"203.0.113.12 0x1 0x0 00:00:00:00:00:00 * eth0\n" +
		"203.0.113.42 0x1 0x2 AA:bb:CC:01:02:03 * eth0\n" +
		"203.0.113.43 0x1 0x2 00:00:00:00:00:00 * eth0\n" +
		"203.0.113.44 0x1 0x2 ff:ff:ff:ff:ff:ff * eth0\n"
	for _, tc := range []struct{ ip, want string }{
		{"203.0.113.42", "aa:bb:cc:01:02:03"},
		{"203.0.113.12", ""}, {"203.0.113.43", ""}, {"203.0.113.44", ""}, {"203.0.113.45", ""},
	} {
		if got := macForIPFromARP(strings.NewReader(arp), tc.ip); got != tc.want {
			t.Errorf("ARP %s = %q, want %q", tc.ip, got, tc.want)
		}
	}
}
