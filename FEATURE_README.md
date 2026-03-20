# Firefox Tab Hibernation, Tab Pause & Bug 1386673 Fix

# Firefox 标签页休眠、标签页暂停与 Bug 1386673 修复

---

## Table of Contents / 目录

1. [Feature Overview / 功能概述](#feature-overview--功能概述)
2. [Tab Hibernation / 标签页休眠](#tab-hibernation--标签页休眠)
3. [Tab Pause / 标签页暂停](#tab-pause--标签页暂停)
4. [Bug 1386673 Fix / Bug 1386673 修复](#bug-1386673-fix--bug-1386673-修复)
5. [Usage Guide / 使用指南](#usage-guide--使用指南)
6. [Technical Architecture / 技术架构](#technical-architecture--技术架构)
7. [File Manifest / 文件清单](#file-manifest--文件清单)
8. [Build & Integration / 构建与集成](#build--integration--构建与集成)

---

## Feature Overview / 功能概述

### English

This branch implements three major features for Firefox:

1. **Tab Hibernation** — Save complete web page content (HTML, CSS, images, fonts) to the Firefox profile directory on disk. Unlike the built-in "Unload Tab" which relies on HTTP cache, hibernated tabs can be restored **offline**, even after cache expiration or clearing. A notification bar warns when restored content may be outdated.

2. **Tab Pause (JS Suspension)** — Completely suspend all JavaScript execution in a tab using two complementary mechanisms: `nsIDOMWindowUtils.suspendTimeouts()` for timer-based APIs and SpiderMonkey's `Debugger` API for active script execution. The page's DOM state is fully preserved.

3. **Bug 1386673 Fix** — Make the `contextualIdentities` permission optional and add a read-only variant (`contextualIdentities.readOnly`). This allows extensions like TreeStyleTab to read container information without forcefully enabling the container feature for users.

### 中文

本分支为 Firefox 实现了三个主要功能：

1. **标签页休眠** — 将完整的网页内容（HTML、CSS、图片、字体）保存到 Firefox 配置目录的磁盘中。与依赖 HTTP 缓存的内建「卸载标签页」不同，休眠的标签页可以**离线**恢复，即使在缓存过期或清除之后。当恢复的内容可能已过期时，会显示通知栏警告。

2. **标签页暂停（JS 挂起）** — 使用两种互补机制完全暂停标签页中的所有 JavaScript 执行：`nsIDOMWindowUtils.suspendTimeouts()` 用于基于计时器的 API，SpiderMonkey 的 `Debugger` API 用于活动脚本执行。页面的 DOM 状态完全保留。

3. **Bug 1386673 修复** — 将 `contextualIdentities` 权限改为可选，并添加只读变体（`contextualIdentities.readOnly`）。这允许像 TreeStyleTab 这样的扩展读取容器信息，而不会强制为用户启用容器功能。

---

## Tab Hibernation / 标签页休眠

### How It Works / 工作原理

#### English

When you hibernate a tab, the following happens:

1. A unique UUID is generated for the hibernation session
2. A directory is created at `[profile]/hibernated-tabs/[uuid]/`
3. Page metadata is collected: URL, title, timestamp, favicon, HTTP cache headers (Cache-Control, Expires, Last-Modified, Pragma), scroll position
4. The metadata is saved to `metadata.json`
5. `nsIWebBrowserPersist.saveDocument()` saves the complete page (HTML + all resources) to `page.html` and `page_files/`
6. The browser is discarded (unloaded from memory) to free resources
7. A blue snowflake icon overlay appears on the tab

When you restore a hibernated tab:

1. `metadata.json` is read to retrieve the original URL and cache headers
2. The saved `page.html` is loaded via `file://` URI
3. Cache expiry is checked using the saved HTTP headers:
   - `Cache-Control: no-store/no-cache` → immediately expired
   - `Cache-Control: max-age=N` → expired if age > N seconds
   - `Expires` header → expired if past the date
   - Fallback: expired if older than 7 days
4. If expired, a notification bar appears: "This page was hibernated N day(s) ago. The content may be outdated." with a "Reload from network" button

#### 中文

当您休眠一个标签页时，会发生以下操作：

1. 为休眠会话生成一个唯一的 UUID
2. 在 `[profile]/hibernated-tabs/[uuid]/` 创建目录
3. 收集页面元数据：URL、标题、时间戳、网站图标、HTTP 缓存头（Cache-Control、Expires、Last-Modified、Pragma）、滚动位置
4. 元数据保存到 `metadata.json`
5. `nsIWebBrowserPersist.saveDocument()` 将完整页面（HTML + 所有资源）保存到 `page.html` 和 `page_files/`
6. 浏览器被丢弃（从内存中卸载）以释放资源
7. 标签页上出现蓝色雪花图标覆盖层

当您恢复休眠的标签页时：

1. 读取 `metadata.json` 以获取原始 URL 和缓存头
2. 通过 `file://` URI 加载保存的 `page.html`
3. 使用保存的 HTTP 头检查缓存过期情况：
   - `Cache-Control: no-store/no-cache` → 立即过期
   - `Cache-Control: max-age=N` → 如果年龄 > N 秒则过期
   - `Expires` 头 → 如果超过日期则过期
   - 兜底：如果超过 7 天则过期
4. 如果已过期，出现通知栏："此页面在 N 天前被休眠。内容可能已过期。"并提供「从网络重新加载」按钮

### Storage Layout / 存储布局

```
[Firefox Profile Directory]/
  hibernated-tabs/
    a1b2c3d4-e5f6-7890-abcd-ef1234567890/
      metadata.json     ← URL, title, timestamp, cache headers
      page.html         ← Complete HTML snapshot
      page_files/       ← CSS, images, fonts, scripts
    f0e1d2c3-b4a5-6789-0abc-def123456789/
      metadata.json
      page.html
      page_files/
```

### Automatic Cleanup / 自动清理

On browser startup, hibernation directories older than **30 days** that are not referenced by any open tab are automatically deleted. This runs during idle time via `ChromeUtils.idleDispatch()`.

浏览器启动时，超过 **30 天**且未被任何打开的标签页引用的休眠目录会自动删除。这通过 `ChromeUtils.idleDispatch()` 在空闲时间运行。

### Safety Checks / 安全检查

- **Disk space**: Requires at least 50 MB free disk space before hibernating
- **Timeout**: Page save operation times out after 60 seconds
- **Cleanup on failure**: Partial files are removed if hibernation fails
- **磁盘空间**：休眠前需要至少 50 MB 可用磁盘空间
- **超时**：页面保存操作在 60 秒后超时
- **失败时清理**：如果休眠失败，部分文件会被清除

---

## Tab Pause / 标签页暂停

### How It Works / 工作原理

#### English

Tab Pause uses two complementary mechanisms to achieve complete JS suspension:

**Mechanism 1: Timer Suspension**
- `nsIDOMWindowUtils.suspendTimeouts()` freezes:
  - `setTimeout` / `setInterval`
  - `requestAnimationFrame`
  - `requestIdleCallback`
  - CSS animations/transitions (partially)
- Applied to the top-level window AND all descendant iframes
- Cross-origin iframes that throw SecurityError are silently skipped

**Mechanism 2: Debugger API**
- SpiderMonkey's `Debugger` API (`addDebuggee()`) provides a "hard stop":
  - Pauses any currently executing script
  - Prevents new scripts from running (event handlers, etc.)
  - Blocks inline `<script>` execution on dynamic DOM insertions
- Also applied to all frames in the page

**Why both are needed:**
- `suspendTimeouts()` alone doesn't stop currently executing code or event handlers
- `Debugger` alone doesn't prevent new timers from being scheduled
- Together, they provide complete JavaScript suspension

#### 中文

标签页暂停使用两种互补机制实现完全的 JS 挂起：

**机制 1：计时器挂起**
- `nsIDOMWindowUtils.suspendTimeouts()` 冻结：
  - `setTimeout` / `setInterval`
  - `requestAnimationFrame`
  - `requestIdleCallback`
  - CSS 动画/过渡（部分）
- 应用于顶级窗口和所有后代 iframe
- 抛出 SecurityError 的跨域 iframe 会被静默跳过

**机制 2：Debugger API**
- SpiderMonkey 的 `Debugger` API（`addDebuggee()`）提供「硬停止」：
  - 暂停任何当前正在执行的脚本
  - 阻止新脚本运行（事件处理程序等）
  - 阻止动态 DOM 插入时的内联 `<script>` 执行
- 同样应用于页面中的所有帧

**为什么两者都需要：**
- 仅 `suspendTimeouts()` 不能停止当前正在执行的代码或事件处理程序
- 仅 `Debugger` 不能阻止新计时器被调度
- 两者结合提供完全的 JavaScript 挂起

### Visual Indicators / 视觉指示器

| State (状态) | Favicon (网站图标) | Label (标签) | Icon Overlay (图标覆盖) |
|---|---|---|---|
| Hibernated (休眠) | 55% opacity (不透明度) | Italic, 80% opacity (斜体, 80% 不透明度) | Blue snowflake (蓝色雪花) |
| Paused (暂停) | 60% grayscale (灰度) | Orange color (橙色) | Orange pause bars (橙色暂停条) |

---

## Bug 1386673 Fix / Bug 1386673 修复

### Problem / 问题

The `contextualIdentities` permission was a `PermissionNoPrompt` — any extension declaring it would:
1. Automatically get full container management access
2. **Force-enable the container feature** for the user, even if they hadn't opted in
3. No way for extensions to just *read* container data without enabling the feature

This was problematic for extensions like **TreeStyleTab** that only need to read container information to color-code tabs — they shouldn't force-enable containers for all users.

`contextualIdentities` 权限之前是 `PermissionNoPrompt`——任何声明它的扩展都会：
1. 自动获得完整的容器管理访问权
2. **强制为用户启用容器功能**，即使用户没有选择加入
3. 扩展没有办法仅*读取*容器数据而不启用该功能

这对于像 **TreeStyleTab** 这样只需要读取容器信息来为标签页着色的扩展来说是有问题的——它们不应该为所有用户强制启用容器。

### Solution / 解决方案

| Permission (权限) | Type (类型) | Enables Containers (启用容器) | Access (访问权限) |
|---|---|---|---|
| `contextualIdentities` | OptionalPermissionNoPrompt | Yes (是) | Read + Write (读写) |
| `contextualIdentities.readOnly` | OptionalPermissionNoPrompt | No (否) | Read only (只读) |

**Behavior changes (行为变更):**
- `get()` with readOnly + containers disabled → returns `null` (not throw)
- `query()` with readOnly + containers disabled → returns `[]` (not throw)
- `create()`, `update()`, `move()`, `remove()` → require full `contextualIdentities` permission
- `onStartup()` → only enables container prefs with full permission

---

## Usage Guide / 使用指南

### Tab Hibernation / 标签页休眠

1. **To hibernate a tab (休眠标签页):**
   - Right-click on any loaded tab → click **"Hibernate Tab"**
   - The tab will show a blue snowflake icon and italic label
   - The tab's memory is freed (browser process discarded)

2. **To restore a hibernated tab (恢复休眠标签页):**
   - Right-click on the hibernated tab → click **"Restore Hibernated Tab"**
   - The saved page loads from disk
   - If content is expired, a notification bar appears with "Reload from network"

3. **When to use (使用场景):**
   - Saving pages for offline reading
   - Reducing memory usage for tabs you want to keep but don't need active
   - Preserving pages that might disappear or change (news articles, etc.)

### Tab Pause / 标签页暂停

1. **To pause a tab (暂停标签页):**
   - Right-click on any loaded tab → click **"Pause Tab (Suspend JS)"**
   - The tab will show an orange pause icon and orange label
   - All JavaScript stops — no timers, no animations, no event handlers

2. **To resume a tab (恢复标签页):**
   - Right-click on the paused tab → click **"Resume Tab"**
   - JavaScript execution resumes from where it was paused

3. **When to use (使用场景):**
   - Stopping CPU-heavy pages from draining battery
   - Pausing auto-playing media or animations
   - Freezing a page state for inspection/debugging
   - Preventing background tabs from making network requests

### Menu Visibility Rules / 菜单可见性规则

| Tab State (标签页状态) | Hibernate (休眠) | Restore (恢复) | Pause (暂停) | Resume (恢复) |
|---|---|---|---|---|
| Normal loaded tab (正常加载的标签页) | Visible (可见) | Hidden (隐藏) | Visible (可见) | Hidden (隐藏) |
| Hibernated tab (休眠的标签页) | Hidden (隐藏) | Visible (可见) | Hidden (隐藏) | Hidden (隐藏) |
| Paused tab (暂停的标签页) | Hidden (隐藏) | Hidden (隐藏) | Hidden (隐藏) | Visible (可见) |
| Loading/pending tab (加载中/待处理的标签页) | Hidden (隐藏) | Hidden (隐藏) | Hidden (隐藏) | Hidden (隐藏) |

---

## Technical Architecture / 技术架构

### Module Dependency Graph / 模块依赖图

```
┌─────────────────────────────────────────────────────────────────┐
│                    Tab Context Menu (右键菜单)                    │
│              main-popupset.inc.xhtml + tabbrowser.js             │
└──────────┬──────────────────────────────┬───────────────────────┘
           │                              │
           ▼                              ▼
┌──────────────────────┐    ┌──────────────────────────┐
│  TabHibernation      │    │  TabPause                │
│  .sys.mjs            │    │  .sys.mjs                │
│                      │    │                          │
│  ◆ nsIWebBrowser-    │    │  ◆ nsIDOMWindowUtils     │
│    Persist           │    │    .suspendTimeouts()    │
│  ◆ IOUtils/PathUtils │    │  ◆ SpiderMonkey          │
│  ◆ nsIHttpChannel    │    │    Debugger API          │
│  ◆ Services.io       │    │  ◆ MessageManager        │
└──────────┬───────────┘    └──────────────────────────┘
           │
           ▼
┌──────────────────────┐
│  SessionStore        │
│  (state persistence) │
│  SessionStore.sys.mjs│
│  TabState.sys.mjs    │
└──────────────────────┘

┌──────────────────────┐    ┌──────────────────────────┐
│  tab.js              │    │  tabs.css                │
│  (DOM attributes)    │    │  (visual indicators)     │
│  hibernated, paused  │    │  snowflake, pause icons  │
└──────────────────────┘    └──────────────────────────┘
```

### Key Firefox APIs Used / 使用的关键 Firefox API

| API | Purpose (用途) | Used In (使用位置) |
|---|---|---|
| `nsIWebBrowserPersist.saveDocument()` | Save complete page to disk (保存完整页面到磁盘) | TabHibernation |
| `IOUtils` / `PathUtils` | Async file I/O (异步文件 I/O) | TabHibernation |
| `nsIHttpChannel.getResponseHeader()` | Extract HTTP cache headers (提取 HTTP 缓存头) | TabHibernation |
| `Services.io.newFileURI()` | Create file:// URI for loading (创建 file:// URI 加载) | TabHibernation |
| `nsIDOMWindowUtils.suspendTimeouts()` | Freeze all timers (冻结所有计时器) | TabPause |
| `Debugger.addDebuggee()` | Halt JS execution (暂停 JS 执行) | TabPause |
| `MessageManager.sendAsyncMessage()` | Cross-process communication (跨进程通信) | TabPause |
| `gBrowser.getNotificationBox()` | Show expiry notification (显示过期通知) | TabHibernation |
| `ChromeUtils.idleDispatch()` | Schedule startup cleanup (调度启动清理) | tabbrowser.js |

### State Management / 状态管理

Both modules use `WeakMap` keyed by `browser.permanentKey` for tracking:

两个模块都使用以 `browser.permanentKey` 为键的 `WeakMap` 进行跟踪：

```javascript
// TabHibernation — tracks hibernated browsers
// TabHibernation — 跟踪休眠的浏览器
const gHibernatedBrowsers = new WeakMap();
// Key: browser.permanentKey → Value: { tabId, url, title, timestamp, cacheHeaders }

// TabPause — tracks paused browsers
// TabPause — 跟踪暂停的浏览器
const gPausedBrowsers = new WeakMap();
// Key: browser.permanentKey → Value: { debugger, timestamp, windows, remote }
```

Using `WeakMap` ensures no memory leaks — when a tab is closed and its browser GC'd, the tracking entry is automatically removed.

使用 `WeakMap` 确保不会内存泄漏——当标签页关闭且其浏览器被垃圾回收时，跟踪条目会自动移除。

### SessionStore Integration / 会话存储集成

The hibernation state is persisted across browser restarts:

休眠状态在浏览器重启后保持：

- **TabState.sys.mjs**: Collects `hibernated` attribute and `_hibernationTabId` from tabs
- **SessionStore.sys.mjs**: Restores the `hibernated` attribute on tab restoration

The **pause** state is NOT persisted — tabs resume JS execution normally on browser restart (pausing is a temporary in-session action).

**暂停**状态不会持久化——标签页在浏览器重启时正常恢复 JS 执行（暂停是临时的会话内操作）。

---

## File Manifest / 文件清单

### New Files (新文件)

| File (文件) | Lines (行数) | Description (描述) |
|---|---|---|
| `browser/components/tabbrowser/TabHibernation.sys.mjs` | ~530 | Core hibernation module (核心休眠模块) |
| `browser/components/tabbrowser/TabPause.sys.mjs` | ~340 | Core JS pause module (核心 JS 暂停模块) |
| `browser/themes/shared/tabbrowser/tab-hibernate.svg` | ~20 | Snowflake icon (雪花图标) |
| `browser/themes/shared/tabbrowser/tab-pause.svg` | ~10 | Pause bars icon (暂停条图标) |

### Modified Files (修改的文件)

| File (文件) | Changes (变更) |
|---|---|
| `browser/components/tabbrowser/content/tabbrowser.js` | Added lazy imports for TabHibernation/TabPause; added 4 gBrowser methods (hibernateTab, restoreHibernatedTab, pauseTab, resumeTab); added context menu visibility logic; added startup cleanup (添加了 TabHibernation/TabPause 的懒加载导入；添加了 4 个 gBrowser 方法；添加了右键菜单可见性逻辑；添加了启动清理) |
| `browser/components/tabbrowser/content/tab.js` | Added `hibernated` and `paused` to inherited attributes for icon-stack, icon-image, icon-overlay, tab-label; added getter properties (添加了 `hibernated` 和 `paused` 到继承属性中；添加了 getter 属性) |
| `browser/base/content/main-popupset.inc.xhtml` | Added 4 context menu items + separator for hibernate/restore/pause/resume (添加了 4 个右键菜单项 + 分隔符) |
| `browser/themes/shared/tabbrowser/tabs.css` | Added ~80 lines for hibernated (blue) and paused (orange) tab visual indicators (添加了约 80 行休眠（蓝色）和暂停（橙色）标签视觉指示器) |
| `browser/locales/en-US/browser/tabContextMenu.ftl` | Added 4 localization strings (添加了 4 个本地化字符串) |
| `browser/components/sessionstore/SessionStore.sys.mjs` | Added hibernation state restoration in `restoreTab()` (在 `restoreTab()` 中添加了休眠状态恢复) |
| `browser/components/sessionstore/TabState.sys.mjs` | Added hibernation state collection in `#collectBaseTabData()` (在 `#collectBaseTabData()` 中添加了休眠状态收集) |
| `browser/components/tabbrowser/moz.build` | Registered TabHibernation.sys.mjs and TabPause.sys.mjs modules (注册了两个新模块) |
| `toolkit/components/extensions/schemas/contextual_identities.json` | Changed permission type to OptionalPermissionNoPrompt; added readOnly variant (将权限类型改为 OptionalPermissionNoPrompt；添加了 readOnly 变体) |
| `toolkit/components/extensions/parent/ext-contextualIdentities.js` | Added checkWritePermission(); modified onStartup() and getAPI() for Bug 1386673 (添加了 checkWritePermission()；为 Bug 1386673 修改了 onStartup() 和 getAPI()) |
| `browser/components/extensions/ext-browser.json` | Updated permissions array to include readOnly (更新权限数组以包含 readOnly) |

---

## Build & Integration / 构建与集成

### Prerequisites / 先决条件

This code is designed for the Firefox build system (`mach`). To apply these changes:

此代码为 Firefox 构建系统（`mach`）设计。要应用这些变更：

1. Clone the official Firefox repository (克隆官方 Firefox 仓库)
2. Apply the changes from this branch (应用此分支的变更)
3. Build Firefox with `./mach build` (使用 `./mach build` 构建 Firefox)

### Verification Without Building / 无需构建的验证

Since the full Firefox build requires a Rust compiler and several GB of toolchain, you can verify the code quality without building:

由于完整的 Firefox 构建需要 Rust 编译器和数 GB 的工具链，您可以在不构建的情况下验证代码质量：

```bash
# Check JavaScript syntax (检查 JavaScript 语法)
node --check browser/components/tabbrowser/TabHibernation.sys.mjs
node --check browser/components/tabbrowser/TabPause.sys.mjs

# Run Firefox ESLint (运行 Firefox ESLint)
./mach lint --linter eslint browser/components/tabbrowser/TabHibernation.sys.mjs
./mach lint --linter eslint browser/components/tabbrowser/TabPause.sys.mjs
```

### Git History / Git 历史

```
Commit 1: efe065a3 — Add tab hibernation and JS pause mechanisms
           添加标签页休眠和 JS 暂停机制

Commit 2: 989c798d — Bug 1386673: Make contextualIdentities optional with readOnly variant
           Bug 1386673：将 contextualIdentities 改为可选并添加 readOnly 变体

Commit 3: (pending) — Add bilingual comments and comprehensive documentation
           添加双语注释和综合文档
```

### Repository / 仓库

- **Fork**: https://github.com/ai2master/firefox
- **Branch**: `feature/tab-hibernate-pause-and-bug-1386673`
- **Base**: `mozilla-firefox/firefox` (official repository)

---

*This implementation follows Firefox coding conventions: ESM modules with lazy getters, Fluent (FTL) localization, XPCOM component usage, WeakMap for lifecycle-safe tracking, and proper error handling with cleanup.*

*此实现遵循 Firefox 编码规范：带懒加载 getter 的 ESM 模块、Fluent (FTL) 本地化、XPCOM 组件使用、用于生命周期安全跟踪的 WeakMap，以及带清理的适当错误处理。*
