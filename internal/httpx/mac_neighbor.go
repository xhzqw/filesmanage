package httpx

import (
	"bufio"
	"io"
	"net"
	"os"
	"strings"
)

// A browser cannot supply a trustworthy MAC address. Read only existing
// server-side LAN-neighbor entries; never use MAC for authentication.
// VPN, routed, and IPv6 clients typically have no observable MAC here.
func clientMACFromARP(addr string) string {
	ip := net.ParseIP(addr)
	if ip == nil || ip.To4() == nil || ip.IsLoopback() || ip.IsUnspecified() || ip.IsMulticast() {
		return ""
	}
	file, err := os.Open("/proc/net/arp")
	if err != nil {
		return ""
	}
	defer file.Close()
	return macForIPFromARP(file, ip.To4().String())
}

func macForIPFromARP(reader io.Reader, address string) string {
	scanner := bufio.NewScanner(reader)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 6 || fields[0] != address || fields[2] != "0x2" {
			continue
		}
		mac, err := net.ParseMAC(fields[3])
		if err != nil || len(mac) != 6 || mac[0]&1 != 0 {
			continue
		}
		zero := true
		for _, b := range mac {
			if b != 0 {
				zero = false
				break
			}
		}
		if !zero {
			return mac.String()
		}
	}
	return ""
}
