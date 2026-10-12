package application

import (
	"context"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type countedReadUOW struct {
	base   ports.UnitOfWork
	search atomic.Int32
	stats  atomic.Int32
}

func (w *countedReadUOW) Begin(ctx context.Context) (ports.Tx, error) {
	tx, err := w.base.Begin(ctx)
	if err != nil {
		return nil, err
	}
	return &countedReadTx{Tx: tx, w: w}, nil
}

type countedReadTx struct {
	ports.Tx
	w *countedReadUOW
}

func (tx *countedReadTx) SearchFiles(ctx context.Context, q ports.FileSearchQuery) ([]domain.File, int, error) {
	tx.w.search.Add(1)
	time.Sleep(40 * time.Millisecond)
	return tx.Tx.SearchFiles(ctx, q)
}

func (tx *countedReadTx) Stats(ctx context.Context, q ports.StatsQuery) (domain.Stats, error) {
	tx.w.stats.Add(1)
	time.Sleep(40 * time.Millisecond)
	return tx.Tx.Stats(ctx, q)
}

func TestConcurrentIdenticalSearchAndStatsShareOneQuery(t *testing.T) {
	s, repo := testService(t)
	wrapper := &countedReadUOW{base: repo}
	s.uow = wrapper
	u := domain.User{ID: "u_admin", IsAdmin: true}
	const concurrency = 20
	var wg sync.WaitGroup
	start := make(chan struct{})
	errs := make(chan error, concurrency)
	for i := 0; i < concurrency; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, err := s.Search(context.Background(), u, SearchFilter{FolderID: "folder_market", Query: "identical"})
			errs <- err
		}()
	}
	close(start)
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if got := wrapper.search.Load(); got != 1 {
		t.Fatalf("identical cold searches executed %d SQL queries; want 1", got)
	}
	start = make(chan struct{})
	errs = make(chan error, concurrency)
	for i := 0; i < concurrency; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, err := s.Stats(context.Background(), u, SearchFilter{FolderID: "folder_market"})
			errs <- err
		}()
	}
	close(start)
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if got := wrapper.stats.Load(); got != 1 {
		t.Fatalf("identical cold stats executed %d SQL queries; want 1", got)
	}
	s.search.invalidate()
	s.stats.invalidate()
	if _, err := s.Search(context.Background(), u, SearchFilter{FolderID: "folder_market", Query: "identical"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Stats(context.Background(), u, SearchFilter{FolderID: "folder_market"}); err != nil {
		t.Fatal(err)
	}
	if wrapper.search.Load() != 2 || wrapper.stats.Load() != 2 {
		t.Fatalf("invalidated caches reused old SQL: search=%d stats=%d", wrapper.search.Load(), wrapper.stats.Load())
	}
}

func TestOfficeDerivativeCacheIsBoundedAndCoalesces(t *testing.T) {
	s, _ := testService(t)
	var count atomic.Int32
	render := func(context.Context) ([]byte, error) {
		count.Add(1)
		time.Sleep(40 * time.Millisecond)
		return []byte("%PDF-1.7 generated"), nil
	}
	const n = 24
	var wg sync.WaitGroup
	start := make(chan struct{})
	errs := make(chan error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			pdf, err := s.cachedOfficePDF(context.Background(), "digest|.docx|", render)
			if err == nil && string(pdf) != "%PDF-1.7 generated" {
				err = ErrInvalidInput
			}
			errs <- err
		}()
	}
	close(start)
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if count.Load() != 1 {
		t.Fatalf("rendered %d times for one immutable blob", count.Load())
	}
	for i := 0; i < officeCacheMaxEntries+3; i++ {
		s.officeCache.put(string(rune('a'+i)), []byte("%PDF"), s.now())
	}
	if len(s.officeCache.entries) > officeCacheMaxEntries || s.officeCache.used > officeCacheMaxBytes {
		t.Fatal("Office derivative cache exceeds its resource limits")
	}
	if _, err := s.cachedOfficePDF(context.Background(), "digest|.docx|", render); err != nil {
		t.Fatal(err)
	}
	if count.Load() != 2 {
		t.Fatal("evicted PDF should be rendered again")
	}
}

func TestOfficeDerivativeWaiterCancellationDoesNotAbortSharedConversion(t *testing.T) {
	s, _ := testService(t)
	started := make(chan struct{})
	release := make(chan struct{})
	render := func(context.Context) ([]byte, error) {
		close(started)
		<-release
		return []byte("%PDF-1.4"), nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	first := make(chan error, 1)
	go func() {
		_, err := s.cachedOfficePDF(ctx, "shared", render)
		first <- err
	}()
	<-started
	cancel()
	if err := <-first; err != context.Canceled {
		t.Fatalf("first caller cancellation: %v", err)
	}
	close(release)
	pdf, err := s.cachedOfficePDF(context.Background(), "shared", render)
	if err != nil || string(pdf) != "%PDF-1.4" {
		t.Fatalf("shared render did not complete: %q %v", pdf, err)
	}
}
