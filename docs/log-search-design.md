# Logger Spirit 设计与工作拆解

## 1. 目标

构建一个纯前端日志分析系统：
- 在浏览器中拖入日志压缩包并递归解压。
- 支持多压缩包并存、左侧树结构浏览。
- 支持跨文件搜索并定位到具体文件行。
- 支持分析过程记录（文字笔记 + 画板线索）。
- 数据存储在用户指定本地目录（File System Access API）。

## 2. 技术栈

- 框架：Next.js (App Router) + React + TypeScript。
- 解压：`fflate`（zip/gzip），自实现 tar 解析器（支持 tar/tar.gz/tgz）。
- 存储：浏览器 File System Access API。
- UI：纯 CSS 三栏布局。

## 3. 核心模块

### 3.1 存储模块（`src/lib/file-system.ts`）

职责：
- 目录选择：`showDirectoryPicker`。
- 写入解压后文件。
- 持久化工作空间元数据（manifest/index）。

存储结构（位于用户选择目录下）：

```text
.logger-spirit-data/
  index.json
  workspaces/
    <workspace-id>/
      manifest.json
      roots/
        <root-id>/
          ...解压后的普通文件目录树
```

### 3.2 归档递归解压（`src/lib/archive.ts`）

职责：
- 识别并递归处理：zip、tar、tar.gz、tgz。
- 遇到嵌套压缩包继续解开，并将压缩层替换为同名目录。
- 输出统一文件列表（path/size/bytes/textLike）。

### 3.3 树与索引（`src/lib/tree.ts`）

职责：
- 根据文件路径生成左侧树结构。
- 目录在前、文件在后排序。

### 3.4 日志工作台（`src/components/logger-spirit-app.tsx`）

职责：
- 左栏：导入、工作空间切换、日志树。
- 中栏：跨文件搜索 + 文件查看。
- 右栏：笔记（自动保存）+ 线索画板。

### 3.5 画板（`src/components/canvas-board.tsx`）

职责：
- 缩放视图。
- 从搜索结果/日志行拖拽文本到画板。
- 卡片可重新拖动、编辑、删除。

## 4. 数据模型

定义在 `src/types/logspace.ts`：
- `WorkspaceManifest`：空间级元数据。
- `RootArchive`：每个导入压缩包展开后的根节点。
- `TreeNode`：左侧树节点。
- `SearchResult`：跨文件搜索命中记录。
- `CanvasState` / `CanvasItem`：画板状态。

## 5. 搜索方案

当前实现：
- 基于 workspace 内已展开文件进行扫描。
- 只扫描文本文件且限制单文件大小（默认 8MB），避免浏览器卡顿。
- 每文件最多保留 10 条命中，总命中上限 500。

后续可升级：
- 增量倒排索引。
- Web Worker 并行索引与搜索。
- 正则搜索与时间范围过滤。

## 6. 对用户需求 10 条能力的映射

1) 纯前端 + 本地存储：已实现。  
2) Next.js 技术栈：已实现。  
3) 拖入压缩包分析：已实现。  
4) zip/tar.gz 多层递归解压并左树展示：已实现。  
5) 中栏查看 + 跨文件搜索：已实现。  
6) Pod 子 zip 不确定位置时快速搜索：已实现（跨 root 扫描）。  
7) 多大 zip 并存联合搜索：已实现。  
8) 右侧记录本随空间打开：已实现（workspace 级持久化）。  
9) 右侧分上下（笔记 + 缩放画板，支持拖入关键点）：已实现。  
10) 其他功能：预留扩展位（见下一节 roadmap）。

## 7. Roadmap（建议下一阶段）

- 大体量日志优化：Web Worker + 分片索引。
- 时间线自动化：从日志中提取时间戳并自动落点到画板。
- 多维过滤：按 pod/container/namespace/时间段过滤。
- 可视化关系：节点连线、聚类、告警链路图。
- 会话导出：笔记 + 画板 + 命中文件导出为 JSON/Markdown。
