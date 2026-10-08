#!/usr/bin/env python3
# Strict Go and TypeScript import-layer boundary test; runs on the TARGET host.
from pathlib import Path
import re,sys
base=Path(__file__).resolve().parents[1]
violations=[]
rules={
 "internal/domain":("github.com/gin-gonic/gin","github.com/jackc/pgx","filesmanage/internal/httpx","filesmanage/internal/adapter"),
 "internal/application":("github.com/gin-gonic/gin","github.com/jackc/pgx","filesmanage/internal/httpx","filesmanage/internal/adapter"),
 "internal/ports":("github.com/gin-gonic/gin","github.com/jackc/pgx","filesmanage/internal/httpx","filesmanage/internal/adapter"),
 "internal/httpx":("github.com/jackc/pgx","filesmanage/internal/adapter"),
 "internal/adapter/postgres":("filesmanage/internal/httpx",),
}
for directory,blocked in rules.items():
 for file in (base/directory).rglob("*.go"):
  text=file.read_text()
  for imported in re.findall(r'(?m)^\s*(?:[a-zA-Z_]+\s+)?\"([^\"]+)\"',text):
   if any(imported.startswith(prefix) for prefix in blocked):violations.append(f"{file.relative_to(base)} imports forbidden {imported}")
for file in (base/"web/src").rglob("*.tsx"):
 content=file.read_text()
 if file.parent.name=="shared" and re.search(r'from\s+[\'\"]\.{1,2}/(?:pages|app|features)',content):
  violations.append(f"{file.relative_to(base)} shared layer depends on upper layer")
if violations:
 print("ARCHITECTURE FAIL:")
 for issue in violations:print(" -",issue)
 sys.exit(1)
print("ARCHITECTURE PASS: checked",sum(1 for _ in (base/"internal").rglob("*.go")),"Go files and TypeScript module boundaries")
