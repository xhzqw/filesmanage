# 中文双字搜索加速与秒搜验收（2026-10-12）

## 问题与原因

`/api/search` 支持正文 `file_text.tsv` 全文匹配与文件名 `ILIKE '%关键词%'` 包含匹配，并保持多租户授权、范围、过滤、排序和游标语义。前批 `pg_trgm` GIN 改善三字以上和英文字母搜索，却不能为恰好两个汉字的任意位置子串提供有效索引。

使用独立 `filesmanage_perf` 中 100,466 文件、402,638 版本的真实数据排查 `导出`：文件名 `ILIKE '%导出%'` 全表扫描 100,466 行约 110ms；服务端为准确统计（总数上限 1001）及获取第一页，需要两次构建结果集合。正文 `tsv @@ phraseto_tsquery('simple','导 出')` 查询仅约 0.2ms、命中 10 条，表明慢点并非全文 GIN 索引。

## 实施

- 迁移 `0026_search_han_bigrams.sql` 新增不可变函数 `fm_search_name_bigrams(name)` 和部分 GIN 表达式索引 `ix_files_active_name_bigrams`；两汉字连续片段随文件新增、重命名和删除事务维护，不用独立搜索服务或异步重建。
- 仅**恰好两个 Unicode Han 字符**的搜索词启用辅助筛选；其他中文长词、单字、拉丁文、混合字符串、SQL 通配符、空格等保留原有路径，避免 Unicode、ILIKE 与分词语义变化。
- 在受限候选预检及少量候选的 ID UNION 分支同时增加 `fm_search_name_bigrams(name) @> ARRAY[$pair]::text[]`；原有 `name ILIKE $pattern` 依然是最终判断条件，正文 tsvector 查询仍单独提供候选。权限和过滤应用于候选集合的外层真实结果查询，预筛选不构成授权或业务计数依据。
- 新增 Go `TestExactHanPairDoesNotChangeGeneralSearchSemantics`；`scripts/perf_han_search_guard.sql` 在独立数据库扫描“导出、预算、文件、边界、中文、研发、市场”真实文件名，验证任何原本命中的名字均不会被双字索引漏掉。
- `scripts/perf_search_probe.py` 增加中文样本；`scripts/perf_large_tree_browser_check.mjs` 增加真实 Chrome 下“导出、预算、文件”输入即搜和数据行数断言。浏览器测试只读并使用 `127.0.0.1:18094`。

## 数据库执行计划：`导出`

| SQL 操作 | 旧扫描 | 双字索引 |
|---|---:|---:|
| 文件名 + 正文受限候选预检 | 110.9ms | 0.8ms |
| 授权条件下的结果计数 | 120.6ms | 0.7ms |

以上为 PostgreSQL `EXPLAIN ANALYZE` 的单次执行，不含服务器、网络、浏览器和缓存。

## 实际 HTTP 响应（单次冷查，远端隔离压测服务）

| 关键词 | 前批新索引方案 | 双字索引后 |
|---|---:|---:|
| 导出（正文 10 条） | 401.5ms | 7.5ms |
| 边界（10 条） | 未测 | 7.5ms |
| 预算（广泛正文词，返回第一页 50 条） | 未测 | 271.5ms |
| 文件（高频文件名，1000+） | 306.5ms | 288.6ms |
| pf_bulk_9627（8 条） | 24.0ms | 27.1ms |
| 无匹配词 | 11.5ms | 6.7ms |

每一条为一次首次 HTTP 观测，不可直接当成 p95；缓存命中通常 1–8ms。高频词不是由两个汉字索引加速的主场景，宽词继续使用原有“有限预检 + 顺序提前终止”的执行路径。

## 实际 Chrome：从输入事件到结果可见

Chrome/146.0.7680.177，`filesmanage_perf` 100,466 文件，只读浏览器：

| 场景 | 行数 | 输入到结果可见 |
|---|---:|---:|
| 文件名 pf_bulk_9627 | 8 | 277ms |
| 导出 | 10 | 368ms |
| 预算 | 50 | 541ms |
| 无匹配 | 0 | 275ms |
| 文件 | 50 | 572ms |

包含 180ms 输入防抖、局域网 HTTP、React 更新和测试轮询时间。当前样本均低于一秒，但**尚不构成跨负载、广泛语料和网络条件下的 p95/p99 搜索 SLA**。

## 交付门禁与范围

- `bash scripts/build.sh --with-tests` 通过 TypeScript/Vite、Rare UI 治理、Go build/vet/tests、架构、OpenAPI、CAD/WebGL、26 份迁移哈希门禁。
- 语义守卫 `HAN_BIGRAM_GUARD_PASS` 与真实 Chrome `PERF_LARGE_TREE_BROWSER_PASS`。
- 全业务隔离 Chrome 及 390/760/1366px UI 门禁结果以本批最终验收为准。
- 仅向 `filesmanage_perf` 和经过地址/库名核验的开发库 `filesmanage_v21` 应用 0026；生产 8091 未启动、停止或变更，根库及用户文件不参与性能夹具。
- 测试服务 18092/18094 用毕关闭，开发 18091 在最新主线构建通过后单独重启。

## 后续方向

针对真实复杂组织 ACL、1–2 字中文高频词、长文档语义搜索、长稳态并发和公网高 RTT 仍需额外语料与 SLO 验收。不要为了显示“秒搜”牺牲授权校验或静默降低全文匹配语义。
