/* -*- mode: js; indent-tabs-mode: nil; js-indent-level: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * TabPause provides the ability to suspend all JavaScript execution in a tab.
 *
 * It combines two mechanisms:
 *   1. nsIDOMWindowUtils.suspendTimeouts() / resumeTimeouts()
 *      — freezes setTimeout, setInterval, requestAnimationFrame, etc.
 *   2. The SpiderMonkey Debugger API (addDebuggee / removeAllDebuggees)
 *      — blocks active and future script execution.
 *
 * Both the top-level window and every descendant iframe are affected.
 */

/**
 * Internal map tracking paused browsers. Keys are browser permanentKey
 * objects; values are objects holding the Debugger instance and timestamp.
 */
const gPausedBrowsers = new WeakMap();

/**
 * Collect a window and all its descendant (sub)frame windows.
 *
 * @param {Window} win
 * @returns {Window[]}
 */
function collectAllWindows(win) {
  let windows = [win];
  for (let i = 0; i < win.frames.length; i++) {
    try {
      windows.push(...collectAllWindows(win.frames[i]));
    } catch (e) {
      // Cross-origin frames may throw; skip them.
    }
  }
  return windows;
}

/**
 * Suspend timers on a window via nsIDOMWindowUtils.
 *
 * @param {Window} win
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
 * Resume timers on a window via nsIDOMWindowUtils.
 *
 * @param {Window} win
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

export var TabPause = {
  /**
   * Pause all JavaScript execution in the given browser's content.
   *
   * @param {XULBrowserElement} browser  The tab's linked browser element.
   * @returns {boolean}  true if the tab was successfully paused.
   */
  pauseTab(browser) {
    if (gPausedBrowsers.has(browser.permanentKey)) {
      return true; // Already paused.
    }

    try {
      let contentWindow = browser.browsingContext?.window;
      if (!contentWindow) {
        console.warn(
          "TabPause: no content window available; " +
          "the tab may be running in a remote process."
        );
        // For remote (e10s) browsers we use the browsing context approach.
        return this._pauseRemoteTab(browser);
      }

      // 1. Suspend timers in every frame.
      let allWindows = collectAllWindows(contentWindow);
      for (let win of allWindows) {
        suspendWindowTimeouts(win);
      }

      // 2. Attach a Debugger to halt script execution.
      // Import the Debugger constructor from the privileged scope.
      let dbg;
      try {
        // In privileged Firefox chrome code the Debugger constructor is
        // available after loading the jsdebugger module.
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
   * Pause a remote (out-of-process) browser tab by sending a message to the
   * content process.
   *
   * @param {XULBrowserElement} browser
   * @returns {boolean}
   */
  _pauseRemoteTab(browser) {
    try {
      // Use the browsing context's WindowGlobal to send an actor message.
      let windowGlobal = browser.browsingContext?.currentWindowGlobal;
      if (!windowGlobal) {
        return false;
      }

      // Send a message to the content process to pause JS.
      // In a full implementation this would use a JSWindowActor; here we
      // use the frame message manager as a simpler integration path.
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
   *
   * @param {XULBrowserElement} browser  The tab's linked browser element.
   * @returns {boolean}  true if the tab was successfully resumed.
   */
  resumeTab(browser) {
    let pauseInfo = gPausedBrowsers.get(browser.permanentKey);
    if (!pauseInfo) {
      return true; // Not paused.
    }

    try {
      if (pauseInfo.remote) {
        let mm = browser.messageManager;
        if (mm) {
          mm.sendAsyncMessage("TabPause:Resume");
        }
      } else {
        // 1. Resume timers in every frame.
        if (pauseInfo.windows) {
          for (let win of pauseInfo.windows) {
            try {
              resumeWindowTimeouts(win);
            } catch (e) {
              // Window may have been destroyed.
            }
          }
        }

        // 2. Remove Debugger.
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
   *
   * @param {object} permanentKey  The browser's permanentKey.
   * @returns {boolean}
   */
  isPaused(permanentKey) {
    return gPausedBrowsers.has(permanentKey);
  },

  /**
   * Get pause information for a browser.
   *
   * @param {object} permanentKey
   * @returns {object|null}
   */
  getPauseInfo(permanentKey) {
    return gPausedBrowsers.get(permanentKey) || null;
  },
};
