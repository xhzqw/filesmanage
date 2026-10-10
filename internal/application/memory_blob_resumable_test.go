package application

import (
	"bytes"
	"errors"
	"io"
)

func (m *memoryBlob) AppendResumable(id string, offset int64, chunk []byte) error {
	if m.resumable == nil {
		m.resumable = map[string][]byte{}
	}
	cur := m.resumable[id]
	if int64(len(cur)) < offset {
		return errors.New("spool too short")
	}
	m.resumable[id] = append(append([]byte{}, cur[:int(offset)]...), chunk...)
	return nil
}
func (m *memoryBlob) OpenResumable(id string) (io.ReadCloser, int64, error) {
	v, ok := m.resumable[id]
	if !ok {
		return nil, 0, errors.New("spool missing")
	}
	return io.NopCloser(bytes.NewReader(v)), int64(len(v)), nil
}
func (m *memoryBlob) RemoveResumable(id string) error { delete(m.resumable, id); return nil }
