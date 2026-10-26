package application

import (
 "encoding/json"
 "testing"
)

func TestDHFPilotRemediationManifestMustChangeExistingRequirement(t *testing.T){
 source:=[]byte(`{"requirements":[{"id":"REQ-A","applicability":"applicable","file_id":"file01","version_seq":1,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},{"id":"REQ-B","applicability":"applicable","file_id":"file02","version_seq":1,"sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}]}`)
 cases:=[]struct{name string;newManifest string;allowed bool}{
  {"same requirements",`{"requirements":[{"id":"REQ-A","applicability":"applicable","file_id":"file01","version_seq":1,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},{"id":"REQ-B","applicability":"applicable","file_id":"file02","version_seq":1,"sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}]}`,false},
  {"new version",`{"requirements":[{"id":"REQ-A","applicability":"applicable","file_id":"file01","version_seq":2,"sha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"},{"id":"REQ-B","applicability":"applicable","file_id":"file02","version_seq":1,"sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}]}`,true},
  {"duplicate requirement",`{"requirements":[{"id":"REQ-A","applicability":"applicable","file_id":"file01","version_seq":2,"sha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"},{"id":"REQ-A","applicability":"applicable","file_id":"file02","version_seq":1,"sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}]}`,false},
  {"missing known obligation",`{"requirements":[{"id":"REQ-A","applicability":"applicable","file_id":"file01","version_seq":2,"sha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}]}`,false},
  {"unknown extra obligation",`{"requirements":[{"id":"REQ-A","applicability":"applicable","file_id":"file01","version_seq":2,"sha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"},{"id":"REQ-Z","applicability":"applicable","file_id":"file02","version_seq":1,"sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}]}`,false},
  {"partial file identity",`{"requirements":[{"id":"REQ-A","applicability":"applicable","file_id":"file01","version_seq":2},{"id":"REQ-B","applicability":"applicable","file_id":"file02","version_seq":1,"sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}]}`,false},
  {"malformed JSON",`{"requirements":[`,false},
 }
 for _,tc:=range cases{t.Run(tc.name,func(t *testing.T){
  _=json.Valid(source)
  got:=changedPilotManifest(source,[]byte(tc.newManifest))
  if got!=tc.allowed{t.Fatalf("changedPilotManifest=%v want %v",got,tc.allowed)}
 })}
}
