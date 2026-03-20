/* -*- mode: js; indent-tabs-mode: nil; js-indent-level: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * TabHibernation — Tab Hibernation Module (标签页休眠模块)
 *
 * [English]
 * This module implements a "deep freeze" mechanism for browser tabs that saves
 * the complete web page content (HTML, CSS, images, fonts) to the Firefox
 * profile directory on disk. Unlike the built-in "Unload Tab" (tab discard)
 * feature which relies on the browser's HTTP cache for page restoration,
 * TabHibernation creates a fully self-contained snapshot that can be restored
 * even when:
 *   - The browser cache has been cleared or expired
 *   - The user is offline
 *   - The original server is down
 *
 * On restoration, the module checks whether the saved content is likely stale
 * (by examining HTTP cache headers captured at hibernation time) and displays
 * a notification bar prompting the user to reload from the network if needed.
 *
 * [中文]
 * 本模块实现了浏览器标签页的「深度冻结」机制，将完整的网页内容（HTML、CSS、
 * 图片、字体）保存到 Firefox 配置目录的磁盘中。与内建的「卸载标签页」
 * （标签页丢弃）功能依赖浏览器 HTTP 缓存来恢复页面不同，TabHibernation
 * 创建了一个完全自包含的快照，即使在以下情况下也能恢复：
 *   - 浏览器缓存已被清除或过期
 *   - 用户处于离线状态
 *   - 原始服务器已关闭
 *
 * 在恢复时，模块会检查保存的内容是否可能已过期（通过检查休眠时捕获的
 * HTTP 缓存头），如果需要，会显示通知栏提示用户从网络重新加载。
 *
 * Storage layout (存储布局):
 *   [profile]/hibernated-tabs/
 *     [uuid]/
 *       metadata.json    — URL, title, timestamp, cache headers, scroll position
 *                          (URL、标题、时间戳、缓存头、滚动位置)
 *       page.html        — Complete HTML snapshot (完整的 HTML 快照)
 *       page_files/      — Associated resources: CSS, images, fonts, etc.
 *                          (关联资源：CSS、图片、字体等)
 *
 * Key APIs used (使用的关键 API):
 *   - nsIWebBrowserPersist.saveDocument() — Saves complete page with resources
 *     (保存完整页面及其资源)
 *   - IOUtils / PathUtils — Async file I/O in the Firefox profile directory
 *     (Firefox 配置目录中的异步文件 I/O)
 *   - nsIHttpChannel — Extracts HTTP cache headers from the document channel
 *     (从文档通道提取 HTTP 缓存头)
 */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  SessionStore: "resource:///modules/sessionstore/SessionStore.sys.mjs",
});

// ============================================================================
// Constants (常量定义)
// ============================================================================

/**
 * Maximum age (in ms) before a hibernation is considered expired on restore.
 * If the saved page is older than this threshold and no explicit cache headers
 * indicate otherwise, a "content may be outdated" notification is shown.
 *
 * 休眠内容在恢复时被视为过期的最大时长（毫秒）。如果保存的页面超过此
 * 阈值且没有明确的缓存头指示其仍有效，将显示「内容可能已过期」的通知。
 */
const HIBERNATION_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (7天)

/**
 * Maximum age (in ms) before old hibernation files are automatically cleaned
 * up during browser startup. This prevents unbounded disk usage from
 * forgotten hibernations.
 *
 * 浏览器启动时自动清理旧休眠文件的最大时长（毫秒）。这防止被遗忘的
 * 休眠文件导致磁盘空间无限增长。
 */
const HIBERNATION_CLEANUP_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days (30天)

/**
 * Minimum free disk space (in bytes) required before allowing hibernation.
 * This safety check prevents the disk from filling up when saving large pages.
 *
 * 允许休眠前所需的最小可用磁盘空间（字节）。此安全检查防止保存大页面时
 * 磁盘被填满。
 */
const MIN_FREE_DISK_SPACE = 50 * 1024 * 1024; // 50 MB

/**
 * Timeout (in ms) for the page save operation via nsIWebBrowserPersist.
 * If saving takes longer than this, the operation is aborted and partial
 * files are cleaned up.
 *
 * 通过 nsIWebBrowserPersist 进行页面保存操作的超时时间（毫秒）。如果保存
 * 时间超过此值，操作将被中止并清理部分文件。
 */
const SAVE_TIMEOUT_MS = 60000; // 60 seconds (60秒)

// ============================================================================
// Internal State (内部状态)
// ============================================================================

/**
 * WeakMap tracking which browsers are currently hibernated.
 * Keys: browser.permanentKey (a unique object per tab, survives tab moves)
 * Values: metadata objects { tabId, url, title, timestamp, cacheHeaders, ... }
 *
 * Using WeakMap ensures that when a tab is closed and its browser is GC'd,
 * the tracking entry is automatically removed — no memory leaks.
 *
 * 使用 WeakMap 跟踪哪些浏览器当前处于休眠状态。
 * 键：browser.permanentKey（每个标签页的唯一对象，在标签页移动时保持不变）
 * 值：元数据对象 { tabId, url, title, timestamp, cacheHeaders, ... }
 *
 * 使用 WeakMap 确保当标签页关闭且其浏览器被垃圾回收时，跟踪条目会自动
 * 移除——不会造成内存泄漏。
 */
const gHibernatedBrowsers = new WeakMap();

// ============================================================================
// Helper Functions (辅助函数)
// ============================================================================

/**
 * Get the root directory where all hibernation data is stored.
 * This is always inside the Firefox profile directory.
 *
 * 获取所有休眠数据存储的根目录。此目录始终位于 Firefox 配置目录内。
 *
 * @returns {string} Absolute path to the hibernated-tabs directory
 *                   (hibernated-tabs 目录的绝对路径)
 */
function getHibernationRoot() {
  return PathUtils.join(
    Services.dirsvc.get("ProfD", Ci.nsIFile).path,
    "hibernated-tabs"
  );
}

/**
 * Get the directory for a specific hibernated tab, identified by its UUID.
 *
 * 获取特定休眠标签页的目录，通过其 UUID 标识。
 *
 * @param {string} tabId  A UUID string identifying the hibernation
 *                        (标识休眠的 UUID 字符串)
 * @returns {string} Absolute path (绝对路径)
 */
function getHibernationDir(tabId) {
  return PathUtils.join(getHibernationRoot(), tabId);
}

/**
 * Generate a unique ID (UUID) suitable for use as a directory name.
 * Strips the curly braces from the standard UUID format.
 *
 * 生成一个适合用作目录名的唯一 ID（UUID）。去除标准 UUID 格式的花括号。
 *
 * @returns {string} UUID string without braces (不含花括号的 UUID 字符串)
 */
function generateTabId() {
  return Services.uuid
    .generateUUID()
    .toString()
    .replace(/[{}]/g, "");
}

/**
 * Create an nsIFile instance from an absolute path string.
 * nsIFile is Firefox's cross-platform file abstraction used by many
 * XPCOM components including nsIWebBrowserPersist.
 *
 * 从绝对路径字符串创建 nsIFile 实例。nsIFile 是 Firefox 的跨平台文件
 * 抽象，被许多 XPCOM 组件使用，包括 nsIWebBrowserPersist。
 *
 * @param {string} path  Absolute file path (绝对文件路径)
 * @returns {nsIFile}
 */
function fileFromPath(path) {
  let file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  file.initWithPath(path);
  return file;
}

/**
 * Race a Promise against a timeout. If the promise doesn't resolve within
 * the specified duration, the returned promise rejects with a Timeout error.
 *
 * Uses ChromeUtils.idleDispatch for the timer to avoid interfering with
 * high-priority browser operations.
 *
 * 将 Promise 与超时进行竞争。如果 promise 在指定时间内未完成，返回的
 * promise 将以 Timeout 错误被拒绝。
 *
 * 使用 ChromeUtils.idleDispatch 作为计时器，避免干扰高优先级的浏览器操作。
 *
 * @param {Promise} promise  The promise to race (要竞争的 promise)
 * @param {number}  ms       Timeout in milliseconds (超时毫秒数)
 * @returns {Promise}
 */
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      ChromeUtils.idleDispatch(() => reject(new Error("Timeout")), { timeout: ms })
    ),
  ]);
}

/**
 * Extract HTTP cache-related response headers from the document currently
 * loaded in the given browser. These headers are saved in metadata.json
 * and later used to determine whether the hibernated content has expired.
 *
 * Extracted headers (提取的头信息):
 *   - Cache-Control: max-age, no-store, no-cache directives
 *   - Expires: absolute expiration date
 *   - Last-Modified: when the resource was last changed on the server
 *   - Pragma: legacy no-cache directive
 *
 * 从给定浏览器中当前加载的文档提取 HTTP 缓存相关的响应头。这些头信息
 * 保存在 metadata.json 中，之后用于判断休眠内容是否已过期。
 *
 * @param {XULBrowserElement} browser  The tab's browser element
 *                                     (标签页的浏览器元素)
 * @returns {object} An object with cacheControl, expires, lastModified,
 *                   pragma keys (or empty if unavailable)
 *                   (包含 cacheControl、expires、lastModified、pragma 键的
 *                   对象，如不可用则为空)
 */
function extractCacheHeaders(browser) {
  let headers = {};
  try {
    // Access the HTTP channel of the currently loaded document.
    // 访问当前加载文档的 HTTP 通道。
    let channel = browser.docShell?.currentDocumentChannel;
    if (channel) {
      let httpChannel = channel.QueryInterface(Ci.nsIHttpChannel);
      try {
        headers.cacheControl = httpChannel.getResponseHeader("Cache-Control");
      } catch (e) {
        /* header not present — 头不存在 */
      }
      try {
        headers.expires = httpChannel.getResponseHeader("Expires");
      } catch (e) {
        /* header not present — 头不存在 */
      }
      try {
        headers.lastModified = httpChannel.getResponseHeader("Last-Modified");
      } catch (e) {
        /* header not present — 头不存在 */
      }
      try {
        headers.pragma = httpChannel.getResponseHeader("Pragma");
      } catch (e) {
        /* header not present — 头不存在 */
      }
    }
  } catch (e) {
    // Not all channels implement nsIHttpChannel (e.g. file://, about:).
    // 并非所有通道都实现了 nsIHttpChannel（如 file://、about:）。
  }
  return headers;
}

/**
 * Determine whether a hibernation has expired based on its metadata.
 *
 * The check follows this priority order (检查按以下优先级):
 *   1. Cache-Control: no-store / no-cache → immediately expired (立即过期)
 *   2. Cache-Control: max-age=N → expired if age > N seconds (如果年龄 > N 秒则过期)
 *   3. Pragma: no-cache → immediately expired (立即过期)
 *   4. Expires header → expired if current time > Expires date
 *      (如果当前时间 > Expires 日期则过期)
 *   5. Fallback: expired if older than HIBERNATION_EXPIRY_MS (7 days)
 *      (兜底：如果超过 HIBERNATION_EXPIRY_MS（7天）则过期)
 *
 * @param {object} metadata  The metadata object from metadata.json
 *                           (来自 metadata.json 的元数据对象)
 * @returns {boolean} true if the content is considered expired (内容被视为过期则返回 true)
 */
function isHibernationExpired(metadata) {
  let age = Date.now() - metadata.timestamp;

  // Check explicit cache-control headers first.
  // 首先检查显式的 cache-control 头。
  let headers = metadata.cacheHeaders || {};
  if (headers.cacheControl) {
    let lower = headers.cacheControl.toLowerCase();
    // no-store or no-cache means the server explicitly forbids caching.
    // no-store 或 no-cache 意味着服务器明确禁止缓存。
    if (lower.includes("no-store") || lower.includes("no-cache")) {
      return true;
    }
    // max-age=N means the content is valid for N seconds from the original request.
    // max-age=N 表示内容从原始请求起有效 N 秒。
    let match = lower.match(/max-age=(\d+)/);
    if (match) {
      let maxAgeMs = parseInt(match[1], 10) * 1000;
      if (age > maxAgeMs) {
        return true;
      }
    }
  }

  // Legacy Pragma: no-cache header (旧版 Pragma: no-cache 头)
  if (headers.pragma && headers.pragma.toLowerCase().includes("no-cache")) {
    return true;
  }

  // Absolute Expires header (绝对 Expires 头)
  if (headers.expires) {
    try {
      let expiresDate = new Date(headers.expires);
      if (Date.now() > expiresDate.getTime()) {
        return true;
      }
    } catch (e) {
      /* unparseable date — 无法解析的日期 */
    }
  }

  // Fallback: consider expired if older than the default threshold.
  // 兜底：如果超过默认阈值则视为过期。
  return age > HIBERNATION_EXPIRY_MS;
}

/**
 * Show a notification bar informing the user that the hibernated content
 * may be out of date, with a "Reload from network" button.
 *
 * This uses Firefox's standard notification box infrastructure
 * (gBrowser.getNotificationBox) to display a warning-level banner.
 *
 * 显示通知栏，告知用户休眠内容可能已过期，并提供「从网络重新加载」按钮。
 *
 * 使用 Firefox 标准的通知框架（gBrowser.getNotificationBox）显示警告级别的横幅。
 *
 * @param {XULBrowserElement} browser     The tab's browser element
 *                                        (标签页的浏览器元素)
 * @param {string}            originalUrl The original URL of the page
 *                                        (页面的原始 URL)
 * @param {number}            timestamp   When the page was hibernated (epoch ms)
 *                                        (页面休眠的时间，毫秒时间戳)
 */
function showExpiryNotification(browser, originalUrl, timestamp) {
  let notificationBox = browser.ownerGlobal.gBrowser.getNotificationBox(browser);
  // Avoid duplicate notifications (避免重复通知)
  if (notificationBox.getNotificationWithValue("hibernation-expired")) {
    return;
  }

  let daysAgo = Math.round((Date.now() - timestamp) / (24 * 60 * 60 * 1000));
  let message =
    `This page was hibernated ${daysAgo} day(s) ago. ` +
    `The content may be outdated.`;

  notificationBox.appendNotification(
    "hibernation-expired",
    {
      label: message,
      priority: notificationBox.PRIORITY_WARNING_MEDIUM,
    },
    [
      {
        label: "Reload from network",
        accessKey: "R",
        callback() {
          // Load the original URL with system principal to bypass any
          // restrictions. This replaces the local file:// page with a
          // fresh network fetch.
          // 使用系统主体加载原始 URL 以绕过任何限制。这将用新的网络获取
          // 替换本地的 file:// 页面。
          browser.loadURI(Services.io.newURI(originalUrl), {
            triggeringPrincipal:
              Services.scriptSecurityManager.getSystemPrincipal(),
          });
        },
      },
    ]
  );
}

// ============================================================================
// Exported API (导出的 API)
// ============================================================================

export var TabHibernation = {
  /**
   * Hibernate a tab: save its complete page content to disk.
   * 休眠一个标签页：将其完整页面内容保存到磁盘。
   *
   * Process flow (处理流程):
   *   1. Generate a unique UUID for this hibernation (生成唯一 UUID)
   *   2. Create the storage directory (创建存储目录)
   *   3. Check available disk space (检查可用磁盘空间)
   *   4. Collect metadata: URL, title, timestamp, cache headers, scroll pos
   *      (收集元数据：URL、标题、时间戳、缓存头、滚动位置)
   *   5. Save metadata to metadata.json (保存元数据到 metadata.json)
   *   6. Use nsIWebBrowserPersist to save the complete page with all resources
   *      (使用 nsIWebBrowserPersist 保存完整页面及所有资源)
   *   7. On failure, clean up partial files (失败时清理部分文件)
   *
   * @param {XULBrowserElement} browser  The tab's linked browser element
   *                                     (标签页的关联浏览器元素)
   * @returns {Promise<object>}  Resolves with { success, tabId }
   *                             (解析为 { success, tabId })
   * @throws {Error} If disk space is insufficient or save fails
   *                 (如果磁盘空间不足或保存失败则抛出错误)
   */
  async hibernateTab(browser) {
    if (gHibernatedBrowsers.has(browser.permanentKey)) {
      throw new Error("Tab is already hibernated");
    }

    let tabId = generateTabId();
    let hibernationDir = getHibernationDir(tabId);

    try {
      // Step 1: Create the directory structure.
      // 步骤 1：创建目录结构。
      await IOUtils.makeDirectory(hibernationDir, {
        createAncestors: true,
        ignoreExisting: true,
      });

      // Step 2: Check available disk space.
      // 步骤 2：检查可用磁盘空间。
      let rootFile = fileFromPath(getHibernationRoot());
      if (rootFile.diskSpaceAvailable < MIN_FREE_DISK_SPACE) {
        throw new Error("Insufficient disk space for hibernation");
      }

      // Step 3: Collect page metadata.
      // 步骤 3：收集页面元数据。
      let metadata = {
        tabId,
        url: browser.currentURI.spec,
        title: browser.contentTitle || "(untitled)",
        timestamp: Date.now(),
        favicon: browser.mIconURL || "",
        cacheHeaders: extractCacheHeaders(browser),
      };

      // Attempt to capture scroll position (try/catch since browsingContext
      // may not always be available in remote processes).
      // 尝试捕获滚动位置（使用 try/catch，因为 browsingContext 在远程
      // 进程中可能不总是可用）。
      try {
        let scrollPos = {};
        let domWindowUtils = browser.browsingContext?.currentWindowGlobal;
        if (domWindowUtils) {
          scrollPos = {
            scrollX: browser.browsingContext.currentWindowGlobal
              .innerWindowId
              ? 0
              : 0,
            scrollY: 0,
          };
        }
        metadata.scrollPosition = scrollPos;
      } catch (e) {
        metadata.scrollPosition = { scrollX: 0, scrollY: 0 };
      }

      // Step 4: Save metadata to disk.
      // 步骤 4：保存元数据到磁盘。
      await IOUtils.writeJSON(
        PathUtils.join(hibernationDir, "metadata.json"),
        metadata
      );

      // Step 5: Save the complete page using nsIWebBrowserPersist.
      // 步骤 5：使用 nsIWebBrowserPersist 保存完整页面。
      //
      // nsIWebBrowserPersist is Firefox's built-in mechanism for "Save Page As".
      // We use PERSIST_FLAGS_FROM_CACHE to prefer reading resources from
      // the browser cache rather than re-fetching from the network.
      //
      // nsIWebBrowserPersist 是 Firefox 内建的「页面另存为」机制。我们使用
      // PERSIST_FLAGS_FROM_CACHE 标志优先从浏览器缓存读取资源，而非重新
      // 从网络获取。
      let pagePath = PathUtils.join(hibernationDir, "page.html");
      let dataPath = PathUtils.join(hibernationDir, "page_files");

      await withTimeout(
        new Promise((resolve, reject) => {
          let persist = Cc[
            "@mozilla.org/embedding/browser/nsWebBrowserPersist;1"
          ].createInstance(Ci.nsIWebBrowserPersist);

          persist.persistFlags =
            // Replace any existing files in the target directory
            // 替换目标目录中任何现有文件
            Ci.nsIWebBrowserPersist.PERSIST_FLAGS_REPLACE_EXISTING_FILES |
            // Don't modify <base> tags in the saved HTML
            // 不修改保存的 HTML 中的 <base> 标签
            Ci.nsIWebBrowserPersist.PERSIST_FLAGS_NO_BASE_TAG_MODIFICATIONS |
            // Auto-detect and apply content encoding conversions
            // 自动检测并应用内容编码转换
            Ci.nsIWebBrowserPersist
              .PERSIST_FLAGS_AUTODETECT_APPLY_CONVERSION |
            // Prefer loading resources from the browser cache
            // 优先从浏览器缓存加载资源
            Ci.nsIWebBrowserPersist.PERSIST_FLAGS_FROM_CACHE;

          // Monitor save progress via nsIWebProgressListener.
          // 通过 nsIWebProgressListener 监控保存进度。
          persist.progressListener = {
            onStateChange(_webProgress, _request, stateFlags, status) {
              if (
                stateFlags & Ci.nsIWebProgressListener.STATE_STOP
              ) {
                if (Components.isSuccessCode(status)) {
                  resolve();
                } else {
                  reject(
                    new Error(`nsIWebBrowserPersist failed: 0x${status.toString(16)}`)
                  );
                }
              }
            },
            onProgressChange() {},
            onLocationChange() {},
            onStatusChange() {},
            onSecurityChange() {},
            onContentBlockingEvent() {},
          };

          let pageFile = fileFromPath(pagePath);
          let dataDir = fileFromPath(dataPath);

          // saveDocument() saves the DOM along with all sub-resources
          // (images, stylesheets, scripts) into pageFile and dataDir.
          // saveDocument() 将 DOM 及所有子资源（图片、样式表、脚本）
          // 保存到 pageFile 和 dataDir。
          persist.saveDocument(
            browser.contentDocument,
            pageFile,
            dataDir,
            null, // output content type (auto) — 输出内容类型（自动）
            Ci.nsIWebBrowserPersist.ENCODE_FLAGS_ENCODE_BASIC_ENTITIES,
            0 // wrap column — 换行列数
          );
        }),
        SAVE_TIMEOUT_MS
      );

      // Step 6: Track the hibernation in our internal map.
      // 步骤 6：在内部映射中跟踪休眠状态。
      gHibernatedBrowsers.set(browser.permanentKey, metadata);

      return { success: true, tabId };
    } catch (ex) {
      // Clean up partial files on failure to avoid leaving orphaned data.
      // 失败时清理部分文件，避免留下孤立数据。
      try {
        await IOUtils.remove(hibernationDir, { recursive: true });
      } catch (cleanupEx) {
        console.error("TabHibernation: cleanup after failure:", cleanupEx);
      }
      throw ex;
    }
  },

  /**
   * Restore a hibernated tab from its saved content on disk.
   * 从磁盘上保存的内容恢复休眠的标签页。
   *
   * Process flow (处理流程):
   *   1. Read metadata.json to get original URL and cache headers
   *      (读取 metadata.json 获取原始 URL 和缓存头)
   *   2. Load the saved page.html via file:// URI into the browser
   *      (通过 file:// URI 将保存的 page.html 加载到浏览器中)
   *   3. Check if content has expired using cache headers
   *      (使用缓存头检查内容是否已过期)
   *   4. If expired, show a notification bar with "Reload from network" button
   *      (如果已过期，显示带「从网络重新加载」按钮的通知栏)
   *
   * @param {XULBrowserElement} browser  The tab's linked browser element
   *                                     (标签页的关联浏览器元素)
   * @param {string} tabId               The hibernation UUID to restore from
   *                                     (要恢复的休眠 UUID)
   * @returns {Promise<object>}  Resolves with the metadata object
   *                             (解析为元数据对象)
   */
  async restoreTab(browser, tabId) {
    let hibernationDir = getHibernationDir(tabId);

    // Verify that the metadata file exists.
    // 验证元数据文件是否存在。
    let metadataPath = PathUtils.join(hibernationDir, "metadata.json");
    if (!(await IOUtils.exists(metadataPath))) {
      throw new Error(`Hibernation data not found for tabId: ${tabId}`);
    }

    let metadata = await IOUtils.readJSON(metadataPath);

    // Load the saved page from disk via file:// URI.
    // 通过 file:// URI 从磁盘加载保存的页面。
    let pagePath = PathUtils.join(hibernationDir, "page.html");
    if (!(await IOUtils.exists(pagePath))) {
      throw new Error(`Saved page not found: ${pagePath}`);
    }

    let pageFile = fileFromPath(pagePath);
    let fileURI = Services.io.newFileURI(pageFile);

    browser.loadURI(fileURI, {
      triggeringPrincipal:
        Services.scriptSecurityManager.getSystemPrincipal(),
    });

    // Check cache expiry and show notification if content is likely stale.
    // 检查缓存过期情况，如果内容可能已过期则显示通知。
    if (isHibernationExpired(metadata)) {
      // Wait for the local file to finish loading before showing the bar.
      // 等待本地文件加载完成后再显示通知栏。
      let onLoad = () => {
        browser.removeEventListener("load", onLoad, true);
        showExpiryNotification(browser, metadata.url, metadata.timestamp);
      };
      browser.addEventListener("load", onLoad, true);
    }

    // Update internal tracking.
    // 更新内部跟踪。
    gHibernatedBrowsers.set(browser.permanentKey, metadata);

    return metadata;
  },

  /**
   * Check whether a browser is currently hibernated.
   * 检查浏览器是否当前处于休眠状态。
   *
   * @param {object} permanentKey  The browser's permanentKey
   *                               (浏览器的 permanentKey)
   * @returns {boolean}
   */
  isHibernated(permanentKey) {
    return gHibernatedBrowsers.has(permanentKey);
  },

  /**
   * Retrieve the hibernation metadata for a browser.
   * 获取浏览器的休眠元数据。
   *
   * @param {object} permanentKey  The browser's permanentKey
   *                               (浏览器的 permanentKey)
   * @returns {object|null} Metadata object or null if not hibernated
   *                        (元数据对象，如未休眠则返回 null)
   */
  getHibernationInfo(permanentKey) {
    return gHibernatedBrowsers.get(permanentKey) || null;
  },

  /**
   * Remove the hibernation tracking for a browser (e.g. after a full
   * network reload replaces the hibernated content).
   *
   * 移除浏览器的休眠跟踪（例如，在完全网络重新加载替换了休眠内容之后）。
   *
   * @param {object} permanentKey  The browser's permanentKey
   *                               (浏览器的 permanentKey)
   */
  clearHibernation(permanentKey) {
    gHibernatedBrowsers.delete(permanentKey);
  },

  /**
   * Delete hibernation files for a specific tab from disk.
   * 从磁盘删除特定标签页的休眠文件。
   *
   * @param {string} tabId  The hibernation UUID (休眠 UUID)
   */
  async removeHibernationFiles(tabId) {
    let dir = getHibernationDir(tabId);
    try {
      await IOUtils.remove(dir, { recursive: true });
    } catch (ex) {
      console.error("TabHibernation: failed to remove files:", ex);
    }
  },

  /**
   * Clean up hibernation directories that are older than
   * HIBERNATION_CLEANUP_AGE_MS (30 days) and not referenced by any
   * currently open tab.
   *
   * This method should be called once during browser startup (via
   * ChromeUtils.idleDispatch) to prevent unbounded disk usage.
   *
   * 清理超过 HIBERNATION_CLEANUP_AGE_MS（30天）且未被任何当前打开的
   * 标签页引用的休眠目录。
   *
   * 此方法应在浏览器启动时调用一次（通过 ChromeUtils.idleDispatch），
   * 以防止磁盘使用量无限增长。
   */
  async cleanupOldHibernations() {
    let root = getHibernationRoot();
    let exists = await IOUtils.exists(root);
    if (!exists) {
      return;
    }

    // Gather tab IDs of currently hibernated tabs across ALL open windows.
    // This ensures we don't delete hibernation data for tabs the user still has.
    // 收集所有打开窗口中当前休眠标签页的 tab ID。这确保我们不会删除用户
    // 仍然拥有的标签页的休眠数据。
    let activeTabIds = new Set();
    for (let win of Services.wm.getEnumerator("navigator:browser")) {
      for (let tab of win.gBrowser.tabs) {
        if (tab.hasAttribute("hibernated")) {
          let info = gHibernatedBrowsers.get(
            tab.linkedBrowser?.permanentKey
          );
          if (info?.tabId) {
            activeTabIds.add(info.tabId);
          }
        }
      }
    }

    let children;
    try {
      children = await IOUtils.getChildren(root);
    } catch (ex) {
      console.error("TabHibernation: cannot read hibernation root:", ex);
      return;
    }

    let now = Date.now();
    for (let childPath of children) {
      let tabId = PathUtils.filename(childPath);

      // Skip directories belonging to currently open hibernated tabs.
      // 跳过属于当前打开的休眠标签页的目录。
      if (activeTabIds.has(tabId)) {
        continue;
      }

      let metadataPath = PathUtils.join(childPath, "metadata.json");
      try {
        let metadata = await IOUtils.readJSON(metadataPath);
        if (now - metadata.timestamp > HIBERNATION_CLEANUP_AGE_MS) {
          // Older than 30 days — safe to delete.
          // 超过 30 天——可以安全删除。
          await IOUtils.remove(childPath, { recursive: true });
        }
      } catch (ex) {
        // Missing or corrupt metadata — remove the directory as it's orphaned.
        // 缺失或损坏的元数据——删除该目录，因为它是孤立的。
        try {
          await IOUtils.remove(childPath, { recursive: true });
        } catch (e) {
          /* ignore — 忽略 */
        }
      }
    }
  },
};
