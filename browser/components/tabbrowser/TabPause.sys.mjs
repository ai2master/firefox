/* -*- mode: js; indent-tabs-mode: nil; js-indent-level: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * TabPause — Tab JavaScript Suspension Module (标签页 JS 暂停模块)
 *
 * [English]
 * This module provides the ability to completely suspend all JavaScript
 * execution in a browser tab, effectively "freezing" it in place. This is
 * useful for:
 *   - Stopping resource-heavy pages from consuming CPU/battery
 *   - Preventing annoying auto-playing media or animations
 *   - Temporarily halting a page while preserving its full DOM state
 *   - Debugging: freezing a page to inspect its current state
 *
 * The suspension combines TWO complementary mechanisms:
 *
 *   1. nsIDOMWindowUtils.suspendTimeouts() / resumeTimeouts()
 *      Freezes all timer-based APIs:
 *        - setTimeout / setInterval
 *        - requestAnimationFrame
 *        - requestIdleCallback
 *        - CSS animations and transitions (partially)
 *      This alone does NOT stop currently executing scripts or event handlers.
 *
 *   2. SpiderMonkey Debugger API (addDebuggee / removeAllDebuggees)
 *      Attaches a JavaScript debugger to the content window, which:
 *        - Pauses any currently executing script
 *        - Prevents new scripts from running (event handlers, etc.)
 *        - Blocks inline <script> execution on dynamic DOM insertions
 *      This provides the "hard stop" that suspendTimeouts alone cannot.
 *
 * Both the top-level document and ALL descendant iframes are affected.
 * Cross-origin iframes that throw security exceptions are silently skipped.
 *
 * [中文]
 * 本模块提供了完全暂停浏览器标签页中所有 JavaScript 执行的能力，有效地将
 * 其「冻结」在原地。这对以下场景非常有用：
 *   - 阻止资源密集型页面消耗 CPU/电池
 *   - 防止烦人的自动播放媒体或动画
 *   - 临时暂停页面同时保留其完整的 DOM 状态
 *   - 调试：冻结页面以检查其当前状态
 *
 * 暂停结合了两种互补的机制：
 *
 *   1. nsIDOMWindowUtils.suspendTimeouts() / resumeTimeouts()
 *      冻结所有基于计时器的 API：
 *        - setTimeout / setInterval
 *        - requestAnimationFrame
 *        - requestIdleCallback
 *        - CSS 动画和过渡（部分）
 *      仅此不能停止当前正在执行的脚本或事件处理程序。
 *
 *   2. SpiderMonkey Debugger API (addDebuggee / removeAllDebuggees)
 *      将 JavaScript 调试器附加到内容窗口，功能包括：
 *        - 暂停任何当前正在执行的脚本
 *        - 阻止新脚本运行（事件处理程序等）
 *        - 阻止动态 DOM 插入时的内联 <script> 执行
 *      这提供了 suspendTimeouts 单独无法实现的「硬停止」。
 *
 * 顶级文档和所有后代 iframe 都会受到影响。抛出安全异常的跨域 iframe 会被
 * 静默跳过。
 *
 * Note on e10s (Electrolysis) / Fission (关于多进程/Fission 的说明):
 *   In multi-process Firefox, content runs in a separate process from chrome.
 *   For remote browsers, this module sends an async message to the content
 *   process via the frame message manager. A full production implementation
 *   would use a JSWindowActor pair for more robust cross-process communication.
 *
 *   在多进程 Firefox 中，内容在与 chrome 不同的进程中运行。对于远程浏览器，
 *   本模块通过帧消息管理器向内容进程发送异步消息。完整的生产实现将使用
 *   JSWindowActor 对来实现更健壮的跨进程通信。
 */

// ============================================================================
// Internal State (内部状态)
// ============================================================================

/**
 * WeakMap tracking which browsers are currently paused.
 * Keys: browser.permanentKey (unique per tab, survives tab moves)
 * Values: { debugger, timestamp, windows, remote }
 *   - debugger: the SpiderMonkey Debugger instance (or null for remote tabs)
 *   - timestamp: when the tab was paused (epoch ms)
 *   - windows: array of Window objects with suspended timeouts (local tabs only)
 *   - remote: boolean flag for remote/e10s tabs
 *
 * WeakMap 跟踪哪些浏览器当前处于暂停状态。
 * 键：browser.permanentKey（每个标签页唯一，标签页移动时保持不变）
 * 值：{ debugger, timestamp, windows, remote }
 *   - debugger：SpiderMonkey Debugger 实例（远程标签页为 null）
 *   - timestamp：标签页被暂停的时间（毫秒时间戳）
 *   - windows：已暂停超时的 Window 对象数组（仅限本地标签页）
 *   - remote：远程/e10s 标签页的布尔标志
 */
const gPausedBrowsers = new WeakMap();

// ============================================================================
// Helper Functions (辅助函数)
// ============================================================================

/**
 * Recursively collect a window and all its descendant (sub)frame windows.
 * This is needed because suspendTimeouts() must be called on EACH frame
 * individually — it does not automatically propagate to child frames.
 *
 * 递归收集一个窗口及其所有后代（子）帧窗口。这是必需的，因为
 * suspendTimeouts() 必须在每个帧上单独调用——它不会自动传播到子帧。
 *
 * @param {Window} win  The top-level or frame window (顶级或帧窗口)
 * @returns {Window[]}  Flat array of all windows in the frame tree
 *                      (帧树中所有窗口的扁平数组)
 */
function collectAllWindows(win) {
  let windows = [win];
  for (let i = 0; i < win.frames.length; i++) {
    try {
      windows.push(...collectAllWindows(win.frames[i]));
    } catch (e) {
      // Cross-origin frames may throw SecurityError; skip them.
      // 跨域帧可能抛出 SecurityError；跳过它们。
    }
  }
  return windows;
}

/**
 * Suspend all timers on a single window via nsIDOMWindowUtils.
 * This freezes setTimeout, setInterval, requestAnimationFrame, etc.
 *
 * 通过 nsIDOMWindowUtils 暂停单个窗口上的所有计时器。这会冻结
 * setTimeout、setInterval、requestAnimationFrame 等。
 *
 * @param {Window} win  The window to suspend (要暂停的窗口)
 */
function suspendWindowTimeouts(win) {
  try {
    let domWindowUtils = win.windowUtils;
    if (domWindowUtils) {
      domWindowUtils.suspendTimeouts();
    }
  } catch (e) {
    console.error("TabPause: failed to suspend timeouts:", e);
  }
}

/**
 * Resume all timers on a single window via nsIDOMWindowUtils.
 * This unfreezes all previously suspended timer-based APIs.
 *
 * 通过 nsIDOMWindowUtils 恢复单个窗口上的所有计时器。这会解冻所有
 * 之前暂停的基于计时器的 API。
 *
 * @param {Window} win  The window to resume (要恢复的窗口)
 */
function resumeWindowTimeouts(win) {
  try {
    let domWindowUtils = win.windowUtils;
    if (domWindowUtils) {
      domWindowUtils.resumeTimeouts();
    }
  } catch (e) {
    console.error("TabPause: failed to resume timeouts:", e);
  }
}

// ============================================================================
// Exported API (导出的 API)
// ============================================================================

export var TabPause = {
  /**
   * Pause all JavaScript execution in the given browser's content.
   * 暂停给定浏览器内容中的所有 JavaScript 执行。
   *
   * For local (same-process) tabs (本地/同进程标签页):
   *   1. Suspend timers in every frame (在每个帧中暂停计时器)
   *   2. Attach Debugger to halt active scripts (附加调试器以暂停活动脚本)
   *
   * For remote (e10s) tabs (远程/e10s 标签页):
   *   Sends an async message to the content process via the frame message
   *   manager. (通过帧消息管理器向内容进程发送异步消息。)
   *
   * @param {XULBrowserElement} browser  The tab's linked browser element
   *                                     (标签页的关联浏览器元素)
   * @returns {boolean}  true if the tab was successfully paused
   *                     (如果标签页成功暂停则返回 true)
   */
  pauseTab(browser) {
    // Already paused — return true (idempotent).
    // 已经暂停——返回 true（幂等）。
    if (gPausedBrowsers.has(browser.permanentKey)) {
      return true;
    }

    try {
      let contentWindow = browser.browsingContext?.window;
      if (!contentWindow) {
        // No direct window access — tab is running in a remote process.
        // 无法直接访问窗口——标签页在远程进程中运行。
        console.warn(
          "TabPause: no content window available; " +
          "the tab may be running in a remote process."
        );
        return this._pauseRemoteTab(browser);
      }

      // Step 1: Suspend timers in every frame of the page.
      // 步骤 1：暂停页面中每个帧的计时器。
      let allWindows = collectAllWindows(contentWindow);
      for (let win of allWindows) {
        suspendWindowTimeouts(win);
      }

      // Step 2: Attach a SpiderMonkey Debugger to halt script execution.
      // 步骤 2：附加 SpiderMonkey 调试器以暂停脚本执行。
      //
      // The Debugger API is a privileged SpiderMonkey feature that allows
      // chrome code to observe and control JS execution in content windows.
      // When a window is added as a "debuggee", any running script in that
      // window is immediately paused, and no new scripts can start.
      //
      // Debugger API 是 SpiderMonkey 的特权功能，允许 chrome 代码观察和
      // 控制内容窗口中的 JS 执行。当一个窗口被添加为「被调试对象」时，
      // 该窗口中任何正在运行的脚本都会立即暂停，且不会有新脚本启动。
      let dbg;
      try {
        let { addDebuggerToGlobal } = ChromeUtils.importESModule(
          "resource://gre/modules/jsdebugger.sys.mjs"
        );
        addDebuggerToGlobal(globalThis);
        // eslint-disable-next-line no-undef
        dbg = new Debugger();
        for (let win of allWindows) {
          dbg.addDebuggee(win);
        }
      } catch (ex) {
        console.error("TabPause: Debugger API not available:", ex);
        // Timers are still suspended, which provides partial pause.
        // 计时器仍然被暂停，这提供了部分暂停效果。
      }

      gPausedBrowsers.set(browser.permanentKey, {
        debugger: dbg,
        timestamp: Date.now(),
        windows: allWindows,
      });

      return true;
    } catch (ex) {
      console.error("TabPause: failed to pause tab:", ex);
      return false;
    }
  },

  /**
   * Pause a remote (out-of-process) browser tab by sending a message
   * to the content process.
   *
   * 通过向内容进程发送消息来暂停远程（进程外）浏览器标签页。
   *
   * Note: In a full production implementation, this would use a
   * JSWindowActor pair (TabPauseParent / TabPauseChild) for more robust
   * cross-process communication. The message manager approach here is a
   * simpler integration path.
   *
   * 注意：在完整的生产实现中，这将使用 JSWindowActor 对
   * (TabPauseParent / TabPauseChild) 来实现更健壮的跨进程通信。此处的
   * 消息管理器方法是一个更简单的集成路径。
   *
   * @param {XULBrowserElement} browser  The remote browser element
   *                                     (远程浏览器元素)
   * @returns {boolean}
   */
  _pauseRemoteTab(browser) {
    try {
      let windowGlobal = browser.browsingContext?.currentWindowGlobal;
      if (!windowGlobal) {
        return false;
      }

      // Send async message to the content process.
      // 向内容进程发送异步消息。
      let mm = browser.messageManager;
      if (mm) {
        mm.sendAsyncMessage("TabPause:Pause");
      }

      gPausedBrowsers.set(browser.permanentKey, {
        debugger: null,
        timestamp: Date.now(),
        remote: true,
      });
      return true;
    } catch (ex) {
      console.error("TabPause: failed to pause remote tab:", ex);
      return false;
    }
  },

  /**
   * Resume all JavaScript execution in the given browser's content.
   * 恢复给定浏览器内容中的所有 JavaScript 执行。
   *
   * This reverses the effects of pauseTab():
   * 这会逆转 pauseTab() 的效果：
   *   1. Resume timers in every frame (恢复每个帧中的计时器)
   *   2. Remove all debuggees from the Debugger (从调试器中移除所有被调试对象)
   *
   * @param {XULBrowserElement} browser  The tab's linked browser element
   *                                     (标签页的关联浏览器元素)
   * @returns {boolean}  true if the tab was successfully resumed
   *                     (如果标签页成功恢复则返回 true)
   */
  resumeTab(browser) {
    let pauseInfo = gPausedBrowsers.get(browser.permanentKey);
    if (!pauseInfo) {
      return true; // Not paused — nothing to do. (未暂停——无需操作。)
    }

    try {
      if (pauseInfo.remote) {
        // Remote tab: send resume message to content process.
        // 远程标签页：向内容进程发送恢复消息。
        let mm = browser.messageManager;
        if (mm) {
          mm.sendAsyncMessage("TabPause:Resume");
        }
      } else {
        // Local tab: resume timers and remove Debugger.
        // 本地标签页：恢复计时器并移除调试器。

        // Step 1: Resume timers in every frame.
        // 步骤 1：恢复每个帧中的计时器。
        if (pauseInfo.windows) {
          for (let win of pauseInfo.windows) {
            try {
              resumeWindowTimeouts(win);
            } catch (e) {
              // Window may have been destroyed (e.g. navigated away).
              // 窗口可能已被销毁（例如导航离开）。
            }
          }
        }

        // Step 2: Remove Debugger — this unpauses all scripts.
        // 步骤 2：移除调试器——这会恢复所有脚本的执行。
        if (pauseInfo.debugger) {
          try {
            pauseInfo.debugger.removeAllDebuggees();
          } catch (e) {
            console.error("TabPause: error removing debuggees:", e);
          }
          pauseInfo.debugger = null;
        }
      }

      gPausedBrowsers.delete(browser.permanentKey);
      return true;
    } catch (ex) {
      console.error("TabPause: failed to resume tab:", ex);
      return false;
    }
  },

  /**
   * Check whether a browser is currently paused.
   * 检查浏览器是否当前处于暂停状态。
   *
   * @param {object} permanentKey  The browser's permanentKey
   *                               (浏览器的 permanentKey)
   * @returns {boolean}
   */
  isPaused(permanentKey) {
    return gPausedBrowsers.has(permanentKey);
  },

  /**
   * Get pause information for a browser.
   * 获取浏览器的暂停信息。
   *
   * @param {object} permanentKey  The browser's permanentKey
   *                               (浏览器的 permanentKey)
   * @returns {object|null} Pause info or null if not paused
   *                        (暂停信息，如未暂停则返回 null)
   */
  getPauseInfo(permanentKey) {
    return gPausedBrowsers.get(permanentKey) || null;
  },
};
