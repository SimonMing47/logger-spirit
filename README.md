# Logger Spirit

纯前端日志分析工作台（Next.js + File System Access API）：

- 拖拽导入 zip / tar.gz（支持多层嵌套 zip、zip in zip、zip in tar.gz）。
- 多日志空间并存（主存储目录下多个 workspace 子目录）。
- 左侧日志树 + 中间多 Tab 日志查看 + 右侧笔记与画板。
- Web Worker 增量索引、跨文件搜索、正则/实时搜索、上下文窗口。
- 自动抽取 timestamp/traceId/spanId，生成跨文件时间线。
- 按 pod/container/namespace/level/time 过滤与聚合。
- 异常模式自动打标签（timeout、connection refused、retry storm 等）。
- 会话快照导出（树状态 + 搜索条件 + 笔记 + 画板）。

## 环境要求

- Node.js 20+
- Chromium 内核浏览器（Chrome / Edge，需支持 File System Access API）

## 本地运行

```bash
npm install
npm run dev
```

打开 [http://localhost:3000](http://localhost:3000)。

## 常用命令

```bash
npm run lint
npm run build
```

## 生成并验证样例压缩包

```bash
bash scripts/generate-sample-archives.sh
npx --yes tsx scripts/validate-sample-archives.ts
```

生成文件位于 `sample-data/generated/`：

- `incident-alpha-2026-02-12.zip`
- `incident-beta-2026-02-12.zip`
- `search-hints.json`

## 使用流程

1. 点击“选择主存储目录”并授权目录读写。
2. 新建日志空间（会在主存储目录下创建 workspace 子目录）。
3. 拖拽或选择压缩包导入，左侧自动展开日志树。
4. 在中栏进行跨文件搜索（支持正则、实时、上下文、过滤）。
5. 命中结果可打开文件定位行，或“一键固定到画板”。
6. 在右侧记录笔记、拖拽线索到画板，进行链路梳理。
7. 导出会话快照用于复盘或协作。
