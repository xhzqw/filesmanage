# Open blockers

Status date: 2026-10-08 (Milestone 1 complete).

| ID | Blocker | Impact | Needed from customer / next probe |
|---|---|---|---|
| BLK-01 | Official 中晟生物科技 Logo binary not yet supplied | Brand page shows explicit "标志待入库" placeholder per DEC-14; must not fake an official logo | Customer delivers verified logo asset (vector/raster) for import |
| BLK-02 | DOCX online editing requires an editor engine (ONLYOFFICE self-hosted preferred) | Milestone 5 editing flow blocked until PoC proves deployment/licensing on 192.168.1.22 | Confirm acceptable to install self-hosted ONLYOFFICE (AGPL) in isolated container; internet/package access for image pull |
| BLK-03 | DWG preview requires a commercial SDK/license (ODA Teigha or similar) | DWG support will be marked license-blocked unless customer procures a license | Customer decision: license purchase or accept DWG = documented unsupported |
| BLK-04 | STEP/IGES server-side converter toolchain (e.g. OpenCASCADE/gmsh) must be installed and proven on target | CAD preview for STEP/IGES unproven until real conversion + geometry verification runs | Approve package installation in worker container |
| BLK-05 | Production port 8091 / systemd cutover not authorized | Delivery stays on dev port 18091; production switch requires explicit approval + backup/rollback drill | Explicit go-live authorization after acceptance gates |

Resolved this milestone:
- ~~Database provisioning~~ → `filesmanage_v21` provisioned (PG 17.9), migrations applied, bootstrap executed.
- ~~Admin first install~~ → admin account live with forced password change completed.
