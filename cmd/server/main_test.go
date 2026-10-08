package main

import "testing"

func TestIsLoopbackAddr(t *testing.T) {
	cases := []struct {
		addr string
		want bool
	}{
		{"127.0.0.1:18091", true},
		{"localhost:18091", true},
		{"[::1]:18091", true},
		{"127.0.0.1", true},
		{"0.0.0.0:18091", false},
		{"192.168.1.22:18091", false},
		{"10.0.0.9:8091", false},
		{"", false},
		{"not-an-addr", false},
	}
	for _, tc := range cases {
		if got := isLoopbackAddr(tc.addr); got != tc.want {
			t.Fatalf("isLoopbackAddr(%q) = %v, want %v", tc.addr, got, tc.want)
		}
	}
}
