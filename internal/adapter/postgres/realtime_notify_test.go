package postgres

import "testing"

func TestSignalRealtimeWakeCoalescesBurstWithoutBlocking(t *testing.T) {
	wake := make(chan struct{}, 1)
	for i := 0; i < 100_000; i++ {
		signalRealtimeWake(wake)
	}
	if len(wake) != 1 {
		t.Fatalf("wake buffer size = %d, want 1", len(wake))
	}
	<-wake
	signalRealtimeWake(wake)
	if len(wake) != 1 {
		t.Fatal("new wake should arrive after consumer drains prior notification")
	}
}
