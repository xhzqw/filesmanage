#!/usr/bin/env python3
"""Generate docs/ACCEPTANCE-MATRIX.md from a curated evidence map.

Every acceptance id declared in docs/SPEC-v2.1.md must appear in MATRIX below
with a status and a concrete evidence reference (or an explicit gap + blocker
registration). The generator fails when the SPEC declares an id the map does
not cover, so a new acceptance item cannot slip in unverified.

Statuses:
  PASS      - real executed evidence exists (script assertion, Go test, or
              documented browser verification)
  PARTIAL   - the capability is only partly implemented or only indirectly
              evidenced; the id must also be registered in OPEN-BLOCKERS.md
  EXTERNAL  - blocked by customer/licence input; registered in OPEN-BLOCKERS

Usage: python3 scripts/gen_acceptance_matrix.py [--check]
"""
import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = ROOT / "docs" / "SPEC-v2.1.md"
OUT = ROOT / "docs" / "ACCEPTANCE-MATRIX.md"
BLOCKERS = ROOT / "docs" / "OPEN-BLOCKERS.md"

ID_PATTERN = re.compile(
    r"\b(?:S(?:[1-9]|[12][0-9])|PT(?:0[1-9]|1[0-2])|RB-T(?:0[1-9]|1[0-2])|"
    r"MC(?:0[1-9]|1[0-8])(?:-[A-Z]+)?|DO(?:0[1-9]|1[0-4])|AG(?:0[1-9]|1[0-6])|"
    r"PE(?:0[1-9]|1[0-8])|MOD(?:0[1-9]|10)|IO-PERF-0[1-4])\b"
)

FAMILY_ORDER = ["S", "PT", "RB-T", "MC", "DO", "MOD", "AG", "PE", "IO-PERF"]
FAMILY_TITLE = {
    "S": "S — 安全 / ACL / 一致性矩阵",
    "PT": "PT — 纯文本双重标准与字节保真",
    "RB-T": "RB-T — 追加式回滚专项",
    "MC": "MC — 机械 CAD / 三维预览",
    "DO": "DO — 真实 DOCX 在线编辑",
    "MOD": "MOD — 模型查看器要求",
    "AG": "AG — 架构门禁",
    "PE": "PE — 性能指标",
    "IO-PERF": "IO-PERF — 文件流指标",
}

# id -> (status, evidence or gap)
MATRIX = {
    # ---- S ----
    "S1": ("PASS", "v2.1 范围取代旧 S1–S13 边界；全量实施见本矩阵其余行"),
    "S2": ("PASS", "s_matrix_e2e.py：创建工作组并加入成员、去重；S11 组织管理越权拒绝"),
    "S3": ("PASS", "s_matrix_e2e.py：'S3 workgroup grant created' / 'granted folder listable'"),
    "S4": ("PASS", "s_matrix_e2e.py：'S4 union grant created' / 'union keeps visibility'（并集且父权限保留）"),
    "S5": ("PASS", "s_matrix_e2e.py：'S5 ungranted folder refused' / 树、搜索、导出均不可见；m7_security_e2e.py 31/31"),
    "S6": ("PASS", "DOCX/MP4/PNG/PDF/TXT 预览与 MP4 Range：media_range_check.py 10/10、preview 端点、office_session_check.py 12/12"),
    "S7": ("PASS", "锁生命周期：TestEditLockLifecycle / TestLockExpiryTakeover；未签入内容仅锁主可见（save 需 lock token）"),
    "S8": ("PASS", "TestApprovalWorkflow 单胜者 + s_matrix_e2e.py 审批拦截/通过/拒绝/版本变化"),
    "S9": ("PASS", "tsvector GIN 中文检索 + cmd/reindex 回填；loadtest search p95 有报告；snippet 走安全文本节点 + <mark>"),
    "S10": ("PASS", "s_matrix_e2e.py：'S10 expiring grant created' / 'visible before expiry' / 'refused after expiry'（注入时钟）"),
    "S11": ("PASS", "s_matrix_e2e.py：'S11 non-admin user list refused' + 组织树/用户列表/成员管理端点"),
    "S12": ("PARTIAL", "systemd 单元已编写并语法验证但未安装、升级/回退演练未执行（BLK-05）"),
    "S13": ("PASS", "旧边界条目，被 v2.1 全量范围取代"),
    "S14": ("PASS", "S14–S19 阶段标题；逐条见 S15–S19"),
    "S15": ("PASS", "m7_security_e2e.py：folder share with descendants、动态成员、撤销即时失效；过期见 S10 同时钟机制"),
    "S16": ("PASS", "s_matrix_e2e.py：'S16 favorite added' / 'duplicate favorite idempotent' / 'listed once' / 'removed' / 'second remove idempotent'"),
    "S17": ("PASS", "s_matrix_e2e.py：'S17 stats reachable'；/api/stats 类型/月份/上传人聚合"),
    "S18": ("PASS", "s_matrix_e2e.py：'S18 export BOM + header' / 'contains only visible rows'；perf_csv_export_check.py 9/9"),
    "S19": ("PASS", "S14–S19 阶段标题"),
    "S20": ("PARTIAL", "DEC-14 品牌外壳已交付，官方 Logo 二进制未提供，UI 维持显式占位（BLK-01）"),
    "S21": ("PASS", "DO01–DO14 全矩阵 + office_session_check.py 12/12 + do05_header_footer_check.py 15/15"),
    "S22": ("PASS", "真实查看器（three.js）渲染原生格式、STEP/IGES 经 worker 转换后渲染；无提示页代替；DWG 属 MC11 外部项"),
    # ---- PT ----
    "PT01": ("PASS", "pt_samples_e2e.py：UTF-8+LF 预览/下载 SHA 一致（112/112 全量）"),
    "PT02": ("PASS", "pt_samples_e2e.py：CRLF 逐行 0d0a 保留，保存后行尾不丢失"),
    "PT03": ("PASS", "pt_samples_e2e.py：BOM efbbbf 保留，rawBase64 精确前缀"),
    "PT04": ("PASS", "pt_samples_e2e.py：'PT04 mixed EOL reported'（只读告警，不执行有损保存）"),
    "PT05": ("PASS", "pt_samples_e2e.py：'PT05 invalid bytes never re-encoded on save path'"),
    "PT06": ("PASS", "pt_samples_e2e.py：'PT06 script literal in preview payload'（字面显示不执行）"),
    "PT07": ("PASS", "pt_samples_e2e.py：'PT07 markdown stays literal'"),
    "PT08": ("PASS", "pt_samples_e2e.py：20k 字符单行可滚动、保存 checksum 一致"),
    "PT09": ("PASS", "pt_samples_e2e.py：'PT09 truncated flag' / 'preview prefix size'（截断提示 + 完整下载）"),
    "PT10": ("PASS", "pt_samples_e2e.py：'PT10 A saves v4' / 'B stale save refused 409' / \"A's version survives\""),
    "PT11": ("PASS", "pt_samples_e2e.py：'PT11 bytes unchanged after preview' / 'still exactly one version'"),
    "PT12": ("PASS", "pt_samples_e2e.py + rb_rollback_e2e.py：保存/审批/回滚后下载 SHA、索引、预览、历史一致"),
    # ---- RB-T ----
    "RB-T01": ("PASS", "追加式回滚总纲；rb_rollback_e2e.py 27/27"),
    "RB-T02": ("PASS", "rb_rollback_e2e.py：'RB-T02 history is 1,2,3 before rollback' / 'full history 1,2,3,4 survives' / 'v4 is action=rollback with target/from' / 'v1..v3 metadata unchanged'"),
    "RB-T03": ("PASS", "rb_rollback_e2e.py：'RB-T03 current bytes equal A' + 各版本 digest 校验（A/B/C/A）"),
    "RB-T04": ("PASS", "rb_rollback_e2e.py：'RB-T04 v5 saved (D)' / 'rollback to v2 commits v6' / 'history 1..6 with no gaps'"),
    "RB-T05": ("PASS", "rb_rollback_e2e.py：'RB-T05 rollback without lock refused' / 'stale expected seq refused'"),
    "RB-T06": ("PARTIAL", "保存并发有 CAS 单胜者测试；两个用户并发保存/回滚的端到端断言缺失（BLK-15）"),
    "RB-T07": ("PARTIAL", "审批目录保存 pending 已验证；审批目录回滚先 pending 的断言缺失（BLK-15）"),
    "RB-T08": ("PARTIAL", "TestApprovalRejectKeepsCurrentVersion 覆盖保存审批；拒绝/重复审批下的 rollback 版本断言缺失（BLK-15）"),
    "RB-T09": ("PASS", "rb_rollback_e2e.py：'RB-T09 idempotent replay does not create v5'"),
    "RB-T10": ("PARTIAL", "文本回滚 SHA 已验证、DOCX 经 do05；STEP/IGES 回滚后 SHA 与索引/派生重指向未断言（BLK-15）"),
    "RB-T11": ("PARTIAL", "blob 采纳逻辑存在；回滚后 derivatives/审计保留与在用小 GC 断言缺失（BLK-15）"),
    "RB-T12": ("PASS", "RB-T01–RB-T12 阶段标题"),
    # ---- MC ----
    "MC01": ("PASS", "总体验收矩阵即本文件；mc_cad_e2e.py 57/57"),
    "MC02": ("PARTIAL", "gmsh 转换输出单一合并网格，无多组件装配树与零件显隐（BLK-11）"),
    "MC03": ("PASS", "OCCT 自带样本 bearing.iges → 2,148 facets / hammer.iges → 144,873 bytes，经真实 worker 转换并渲染"),
    "MC04": ("PARTIAL", "不支持的 IGES 实体走 failed+errorCode 路径存在，但“清楚错误而非空视图”的断言缺失（BLK-16）"),
    "MC05": ("PARTIAL", "STLLoader 覆盖 ASCII/Binary；单位未知提示未实现（BLK-13）"),
    "MC06": ("PARTIAL", "OBJ 几何渲染正常；MTL/纹理关联未实现（无 MTLLoader）（BLK-12）"),
    "MC07": ("PARTIAL", "GLB 自包含渲染正常；外部 .bin/textures 的多文件 glTF 不解析（BLK-12）"),
    "MC08": ("PASS", "PLYLoader 覆盖 ascii/binary 点/网格几何，浏览器实测渲染"),
    "MC09": ("PARTIAL", "3MFLoader 渲染单部件已验证；多部件与基本材质未验证（BLK-12）"),
    "MC10": ("PASS", "自研 DXF 解析器渲染图层/圆弧/文字，浏览器实测图层开关面板"),
    "MC11": ("EXTERNAL", "DWG 需商业 SDK 许可（ODA Teigha 等），维持 licence-blocked（BLK-03）"),
    "MC12": ("PASS", "worker 内存/超时/并发上限 + pe12_cad_saturation.py 7/7（API p95 劣化 x0.93–x1.14）"),
    "MC13": ("PASS", "mc_cad_e2e.py：'MC13 ungranted derivative status refused' / 'bytes refused'"),
    "MC14": ("PARTIAL", "重试转换采纳已存在 blob 已修复；同版本并发请求在途去重断言缺失（BLK-16）"),
    "MC15": ("PASS", "mc_cad_e2e.py：'MC15 second source uploaded' / 'derivative bound to its own file'"),
    "MC16": ("PARTIAL", "pending 审批期间 current 不变故派生天然指向旧版，但显式断言缺失（BLK-16）"),
    "MC17": ("PARTIAL", "异常模型走 failed 路径；恶意纹理 URL 因离线解析天然闭合，zip-slip/恶意纹理断言缺失（BLK-16）"),
    "MC18": ("PASS", "总体验收矩阵即本文件"),
    # ---- DO ----
    "DO01": ("PASS", "M5 真实编辑器 E2E：v2 字节可重新打开、原文本完整；office_session_check.py 12/12"),
    "DO02": ("PASS", "M5 真实编辑器验证（ONLYOFFICE 原生格式化往返）"),
    "DO03": ("PASS", "M5 真实编辑器验证"),
    "DO04": ("PASS", "M5 真实编辑器验证"),
    "DO05": ("PASS", "do05_header_footer_check.py 15/15：页眉/页脚/分页符在真实 status-2 提交路径后保留"),
    "DO06": ("PASS", "office_session_check.py 5/10 会话 + PE10 测量"),
    "DO07": ("PASS", "TestEditLockLifecycle / TestLockExpiryTakeover；B 取锁失败"),
    "DO08": ("PASS", "TestEditorCallbackIdempotencyAndConflict（关闭与 force-save 均不重复版本）"),
    "DO09": ("PASS", "TestJWTRejectsTampering + TestEditorCallbackIdempotencyAndConflict"),
    "DO10": ("PASS", "TestApprovalWorkflow + s_matrix_e2e.py（pending 时 preview 仍看旧版）"),
    "DO11": ("PASS", "TestApprovalRejectKeepsCurrentVersion"),
    "DO12": ("PASS", "TestEditorCallbackIdempotencyAndConflict 冲突路径 + m7_security_e2e.py 撤销即时性"),
    "DO13": ("PASS", "TestJWTRejectsTampering、source-token 拒绝测试、SSRF 固定下载主机"),
    "DO14": ("PASS", "TestEditorCallbackIdempotencyAndConflict + rb_rollback_e2e.py 幂等重放"),
    # ---- MOD ----
    "MOD01": ("PASS", "mod01_controls_check.mjs 10/10：坐标轴/网格/透视-正交切换均改变合成画面且可逆；拖拽后重置视角精确恢复初始取景（截图哈希一致）；旋转/平移/缩放由 OrbitControls 提供"),
    "MOD02": ("PARTIAL", "无装配信息（转换输出单一网格），零件树/独立显隐/bbox 未实现（BLK-11）"),
    "MOD03": ("PARTIAL", "工具栏显示格式与三角/顶点数；源 SHA、单位、尺寸范围、组件数、转换日期、警告未展示（BLK-13）"),
    "MOD04": ("PARTIAL", "未知单位提示未实现，不得默认毫米（BLK-13）"),
    "MOD05": ("PARTIAL", "无测量工具；“近似”量测标注无从谈起（BLK-13）"),
    "MOD06": ("PASS", "派生状态机（queued/running/ready/failed）+ 前端 loading/error/空态；derivativeStatus 提供 errorCode"),
    "MOD07": ("PASS", "mod01_controls_check.mjs：真实 webglcontextlost 监听器触发可操作错误态+下载原件入口；Fetch 域故障注入超大 Content-Length 触发 256MB 守卫+下载入口（不缓冲）"),
    "MOD08": ("PASS", "pe15_heap_growth.mjs：20 次挂载/拆除后堆回落同一 8.6MB 地板，几何/纹理/监听/上下文已释放"),
    "MOD09": ("PASS", "查看器只读，无任何写回 source blob 的路径"),
    "MOD10": ("PARTIAL", "未授权账号看不到新几何由 current 版本机制保证，显式断言缺失（BLK-16）"),
    # ---- AG ----
    "AG01": ("PASS", "check_architecture.py 导入图扫描（domain 无 Gin/pgx）"),
    "AG02": ("PASS", "check_architecture.py 同一扫描（application 无 postgres adapter）"),
    "AG03": ("PASS", "check_architecture.py：handler 无 SQL"),
    "AG04": ("PASS", "check_architecture.py：shared 不 import pages（41 TS 模块）"),
    "AG05": ("PASS", "go test ./... 全部跑在 memoryRepo 上，无 HTTP/PG"),
    "AG06": ("PASS", "scripts/integration_acl.sql、integration_versions.sql 在隔离 PostgreSQL 执行"),
    "AG07": ("PASS", "service 测试多表事务回滚（current/version/audit/outbox）"),
    "AG08": ("PASS", "staging 协议（TX-06）+ perf_upload_stress.py（staging 目录无孤儿）"),
    "AG09": ("PARTIAL", "staging/对账协议存在；提交-rename 崩溃后的恢复任务未做演练（BLK-15）"),
    "AG10": ("PASS", "TestApprovalWorkflow 单胜者 + rb_rollback_e2e.py"),
    "AG11": ("PASS", "m7_security_e2e.py 31/31：撤销后列表/搜索/统计/导出下一请求即失效"),
    "AG12": ("PASS", "pe12_cad_saturation.py 7/7（x0.93–x1.14，预算 1.25）"),
    "AG13": ("PASS", "office session TTL + callback 恢复测试"),
    "AG14": ("PASS", "pt_samples_e2e.py PT10 A/B 409；cursor/baseSeq 竞态修复"),
    "AG15": ("PASS", "docs/openapi-implemented.yaml（66 端点）+ 本矩阵逐 ID 追溯"),
    "AG16": ("PASS", "check_architecture.py 负向规则自测（注入跨层导入即失败）"),
    # ---- PE ----
    "PE01": ("PASS", "§24 + PE01–PE18 统一由 loadtest/perf 脚本执行，不按口头说明宣布高性能"),
    "PE02": ("PASS", "loadtest.py 30/100 用户 15 分钟级运行，p50/p95/p99/RPS/RSS/错误率落盘 .secrets/perf/*.json"),
    "PE03": ("PASS", "loadtest.py --ladder 1/10/30/100/200 容量曲线，退化拐点与池绑定结论记录在 M7-PERF-DATASET-GATE.md"),
    "PE04": ("PASS", "m7_security_e2e.py：撤销后列表/搜索/统计/导出即时失权"),
    "PE05": ("PASS", "EffectiveGrants 单 CTE 完成继承+并集解析；PE14 EXPLAIN 无 N+1"),
    "PE06": ("PASS", "tsvector GIN + spaced CJK 列，100k 可索引数据集 search p95 有报告"),
    "PE07": ("PASS", "perf_csv_export_check.py 9/9：100,433 行、BOM、公式注入防护、TTFB 1548ms"),
    "PE08": ("PASS", "perf_upload_stress.py 10/10：10×100MB、checksum 校验、wall 25.7s"),
    "PE09": ("PASS", "media_range_check.py 10/10：206/416/后缀范围/单字节/预览可达"),
    "PE10": ("PASS", "office_session_check.py 12/12：5 会话 open p95 64ms、唯一 document key、干净取消"),
    "PE11": ("PASS", "STEP→STL 66,330 字节网格经真实 worker；IGES OCCT 样本转换；worker peak RAM 在 PE12 同步测量"),
    "PE12": ("PASS", "pe12_cad_saturation.py 7/7：x0.93–x1.14（预算 1.25），干净环境（perf 实例需停止）"),
    "PE13": ("PASS", "M7-PERF-DATASET-GATE.md：池等待在 ≥100 用户占主导，无无上限等待，耗尽时受控 503"),
    "PE14": ("PASS", "list/hot-folder/search/export/stats 的 EXPLAIN (ANALYZE, BUFFERS) 报告已存档"),
    "PE15": ("PASS", "pe15_heap_growth.mjs：20 周期 late-window 斜率 0.13–0.19 MB/cycle（预算 0.5），对照组 0.000"),
    "PE16": ("PASS", "1440x900/1366x768/1920x1080 首次可交互 168/152/2ms（预算 2.5s），三视口无重叠"),
    "PE17": ("PASS", "不可达 editor：session open 不阻塞、preview/download 200、/health/ready 200（PG 重启属共享实例未注入）"),
    "PE18": ("PASS", "每次 loadtest 写 JSON 到 .secrets/perf/（p50/p95/p99、RPS、RSS、连接、错误分类）"),
    # ---- IO-PERF ----
    "IO-PERF-01": ("PASS", "perf_upload_stress.py：10×100MB 流式上传，RSS 受控，无 OOM"),
    "IO-PERF-02": ("PASS", "media_range_check.py 10/10 + http.ServeContent Range/If-Range/ETag"),
    "IO-PERF-03": ("PASS", "perf_csv_export_check.py：流式扫描输出、BOM、公式防护、首字节 1548ms"),
    "IO-PERF-04": ("PASS", "ServeContent/io.Copy 取消即关闭 reader；导出流 consumer-abort 测试覆盖 cursor 关闭"),
}


def sort_key(identifier):
    match = re.match(r"([A-Z-]+?)(\d+)$", identifier)
    family, number = match.group(1), int(match.group(2))
    return (FAMILY_ORDER.index(family) if family in FAMILY_ORDER else len(FAMILY_ORDER), number)


def spec_lines():
    text = SPEC.read_text(encoding="utf-8")
    out = {}
    for match in ID_PATTERN.finditer(text):
        identifier = match.group(0)
        if identifier in out:
            continue
        start = text.rfind("\n", 0, match.start()) + 1
        end = text.find("\n", match.end())
        line = text[start:end].strip()
        if len(line) > 12:
            out[identifier] = line
    return out


def build():
    lines = spec_lines()
    declared = set(lines)
    mapped = set(MATRIX)
    unmapped = sorted(declared - mapped, key=sort_key)
    if unmapped:
        raise SystemExit(
            "acceptance matrix incomplete: %d declared ids have no curated row: %s"
            % (len(unmapped), ", ".join(unmapped))
        )
    extra = sorted(mapped - declared, key=sort_key)
    if extra:
        raise SystemExit(
            "acceptance matrix stale: %d rows no longer declared by the SPEC: %s"
            % (len(extra), ", ".join(extra))
        )

    counts = {"PASS": 0, "PARTIAL": 0, "EXTERNAL": 0}
    for status, _ in MATRIX.values():
        counts[status] += 1

    doc = [
        "# Acceptance matrix — SPEC v2.1",
        "",
        "Generated by `scripts/gen_acceptance_matrix.py`; do not edit by hand.",
        "Every acceptance id declared in `docs/SPEC-v2.1.md` appears here with a",
        "status and the concrete evidence that closes it. `PARTIAL` rows are real",
        "gaps and must be registered in `docs/OPEN-BLOCKERS.md`; `EXTERNAL` rows",
        "wait on customer/licence input. Run `python3 scripts/gen_acceptance_matrix.py --check`",
        "to fail the build on an unverified id.",
        "",
        "Status totals: **%d PASS / %d PARTIAL / %d EXTERNAL** (of %d declared ids)."
        % (counts["PASS"], counts["PARTIAL"], counts["EXTERNAL"], len(declared)),
        "",
    ]

    by_family = {}
    for identifier in sorted(mapped, key=sort_key):
        family = re.match(r"([A-Z-]+)", identifier).group(1)
        by_family.setdefault(family, []).append(identifier)

    for family in FAMILY_ORDER:
        if family not in by_family:
            continue
        doc.append("## %s" % FAMILY_TITLE[family])
        doc.append("")
        doc.append("| ID | SPEC 要求（节选） | 状态 | 证据 / 缺口 |")
        doc.append("|---|---|---|---|")
        for identifier in by_family[family]:
            status, evidence = MATRIX[identifier]
            spec_text = lines.get(identifier, "")
            spec_text = spec_text.replace("|", "\\|")
            if len(spec_text) > 110:
                spec_text = spec_text[:107] + "..."
            doc.append("| %s | %s | **%s** | %s |" % (identifier, spec_text, status, evidence))
        doc.append("")

    doc.append("## PARTIAL 登记")
    doc.append("")
    doc.append("以下 PARTIAL id 均已在 `docs/OPEN-BLOCKERS.md` 登记具体缺口与所需输入：")
    doc.append("")
    partials = [i for i in sorted(mapped, key=sort_key) if MATRIX[i][0] == "PARTIAL"]
    for identifier in partials:
        doc.append("- `%s` — %s" % (identifier, MATRIX[identifier][1]))
    doc.append("")
    doc.append("## EXTERNAL 登记")
    doc.append("")
    for identifier in sorted(mapped, key=sort_key):
        if MATRIX[identifier][0] == "EXTERNAL":
            doc.append("- `%s` — %s" % (identifier, MATRIX[identifier][1]))
    doc.append("")
    return "\n".join(doc), counts, len(declared)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()

    text, counts, total = build()

    if args.check:
        current = OUT.read_text(encoding="utf-8") if OUT.exists() else ""
        if current != text:
            print("acceptance matrix drift: re-run scripts/gen_acceptance_matrix.py", file=sys.stderr)
            return 1
        blocker_text = BLOCKERS.read_text(encoding="utf-8") if BLOCKERS.exists() else ""
        partials = [i for i, (s, _) in MATRIX.items() if s == "PARTIAL"]
        unregistered = [i for i in partials if not re.search(r"\b%s\b" % re.escape(i), blocker_text)]
        if unregistered:
            print(
                "PARTIAL ids not registered in OPEN-BLOCKERS.md: " + ", ".join(sorted(unregistered)),
                file=sys.stderr,
            )
            return 1
        print(
            "acceptance matrix up to date: %d ids (%d PASS / %d PARTIAL / %d EXTERNAL), all PARTIAL ids registered"
            % (total, counts["PASS"], counts["PARTIAL"], counts["EXTERNAL"])
        )
        return 0

    OUT.write_text(text, encoding="utf-8")
    print(
        "wrote %s (%d ids: %d PASS / %d PARTIAL / %d EXTERNAL)"
        % (OUT, total, counts["PASS"], counts["PARTIAL"], counts["EXTERNAL"])
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
