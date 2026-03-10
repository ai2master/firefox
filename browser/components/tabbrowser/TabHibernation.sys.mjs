/* -*- mode: js; indent-tabs-mode: nil; js-indent-level: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * TabHibernation saves complete web page content to disk (inside the Firefox
 * profile directory) so that tabs can be restored offline, independent of the
 * browser cache. On restoration it checks whether the cached content is likely
 * stale and presents a notification bar when appropriate.
 */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  SessionStore: "resource:///modules/sessionstore/SessionStore.sys.mjs",
});

// Maximum age (ms) before a hibernation is considered expired on restore.
const HIBERNATION_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Maximum age (ms) before old hibernation files are cleaned up on startup.
const HIBERNATION_CLEANUP_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Minimum free disk space (bytes) required before allowing hibernation.
const MIN_FREE_DISK_SPACE = 50 * 1024 * 1024; // 50 MB

// Timeout (ms) for the page save operation.
const SAVE_TIMEOUT_MS = 60000;

/**
 * Internal map tracking hibernated browsers. Keys are browser permanentKey
 * objects; values are hibernation metadata objects.
 */
const gHibernatedBrowsers = new WeakMap();

/**
 * Returns the root directory where all hibernation data is stored.
 */
function getHibernationRoot() {
  return PathUtils.join(
    Services.dirsvc.get("ProfD", Ci.nsIFile).path,
    "hibernated-tabs"
  );
}

/**
 * Returns the directory for a specific hibernated tab.
 *
 * @param {string} tabId  A unique identifier for the tab.
 * @returns {string}
 */
function getHibernationDir(tabId) {
  return PathUtils.join(getHibernationRoot(), tabId);
}

/**
 * Generate a unique ID suitable for use as a directory name.
 *
 * @returns {string}
 */
function generateTabId() {
  return Services.uuid
    .generateUUID()
    .toString()
    .replace(/[{}]/g, "");
}

/**
 * Create an nsIFile from an absolute path string.
 *
 * @param {string} path
 * @returns {nsIFile}
 */
function fileFromPath(path) {
  let file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  file.initWithPath(path);
  return file;
}

/**
 * Race a promise against a timeout.
 *
 * @param {Promise} promise
 * @param {number}  ms  Timeout in milliseconds.
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
 * Attempt to extract HTTP cache-related headers from the current document
 * loaded in the given browser.
 *
 * @param {XULBrowserElement} browser
 * @returns {object}
 */
function extractCacheHeaders(browser) {
  let headers = {};
  try {
    let channel = browser.docShell?.currentDocumentChannel;
    if (channel) {
      let httpChannel = channel.QueryInterface(Ci.nsIHttpChannel);
      try {
        headers.cacheControl = httpChannel.getResponseHeader("Cache-Control");
      } catch (e) {
        /* header not present */
      }
      try {
        headers.expires = httpChannel.getResponseHeader("Expires");
      } catch (e) {
        /* header not present */
      }
      try {
        headers.lastModified = httpChannel.getResponseHeader("Last-Modified");
      } catch (e) {
        /* header not present */
      }
      try {
        headers.pragma = httpChannel.getResponseHeader("Pragma");
      } catch (e) {
        /* header not present */
      }
    }
  } catch (e) {
    // Not all channels implement nsIHttpChannel.
  }
  return headers;
}

/**
 * Determine whether a hibernation has expired based on its metadata.
 *
 * @param {object} metadata
 * @returns {boolean}
 */
function isHibernationExpired(metadata) {
  let age = Date.now() - metadata.timestamp;

  // Check explicit cache-control headers first.
  let headers = metadata.cacheHeaders || {};
  if (headers.cacheControl) {
    let lower = headers.cacheControl.toLowerCase();
    if (lower.includes("no-store") || lower.includes("no-cache")) {
      return true;
    }
    let match = lower.match(/max-age=(\d+)/);
    if (match) {
      let maxAgeMs = parseInt(match[1], 10) * 1000;
      if (age > maxAgeMs) {
        return true;
      }
    }
  }
  if (headers.pragma && headers.pragma.toLowerCase().includes("no-cache")) {
    return true;
  }
  if (headers.expires) {
    try {
      let expiresDate = new Date(headers.expires);
      if (Date.now() > expiresDate.getTime()) {
        return true;
      }
    } catch (e) {
      /* unparseable date */
    }
  }

  // Fallback: consider expired if older than the default threshold.
  return age > HIBERNATION_EXPIRY_MS;
}

/**
 * Show a notification bar on the given browser to inform the user that the
 * hibernated content may be out of date.
 *
 * @param {XULBrowserElement} browser
 * @param {string} originalUrl  The original URL of the page.
 * @param {number} timestamp    When the page was hibernated (epoch ms).
 */
function showExpiryNotification(browser, originalUrl, timestamp) {
  let notificationBox = browser.ownerGlobal.gBrowser.getNotificationBox(browser);
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
          browser.loadURI(Services.io.newURI(originalUrl), {
            triggeringPrincipal:
              Services.scriptSecurityManager.getSystemPrincipal(),
          });
        },
      },
    ]
  );
}

export var TabHibernation = {
  /**
   * Hibernate a tab by saving its complete page content to disk.
   *
   * @param {XULBrowserElement} browser  The tab's linked browser element.
   * @returns {Promise<object>}  Resolves with { success, tabId } or throws.
   */
  async hibernateTab(browser) {
    if (gHibernatedBrowsers.has(browser.permanentKey)) {
      throw new Error("Tab is already hibernated");
    }

    let tabId = generateTabId();
    let hibernationDir = getHibernationDir(tabId);

    try {
      // Ensure the root and tab-specific directories exist.
      await IOUtils.makeDirectory(hibernationDir, {
        createAncestors: true,
        ignoreExisting: true,
      });

      // Check available disk space.
      let rootFile = fileFromPath(getHibernationRoot());
      if (rootFile.diskSpaceAvailable < MIN_FREE_DISK_SPACE) {
        throw new Error("Insufficient disk space for hibernation");
      }

      // Collect page metadata.
      let metadata = {
        tabId,
        url: browser.currentURI.spec,
        title: browser.contentTitle || "(untitled)",
        timestamp: Date.now(),
        favicon: browser.mIconURL || "",
        cacheHeaders: extractCacheHeaders(browser),
      };

      // Attempt to capture scroll position.
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

      // Save metadata to JSON.
      await IOUtils.writeJSON(
        PathUtils.join(hibernationDir, "metadata.json"),
        metadata
      );

      // Save the complete page using nsIWebBrowserPersist.
      let pagePath = PathUtils.join(hibernationDir, "page.html");
      let dataPath = PathUtils.join(hibernationDir, "page_files");

      await withTimeout(
        new Promise((resolve, reject) => {
          let persist = Cc[
            "@mozilla.org/embedding/browser/nsWebBrowserPersist;1"
          ].createInstance(Ci.nsIWebBrowserPersist);

          persist.persistFlags =
            Ci.nsIWebBrowserPersist.PERSIST_FLAGS_REPLACE_EXISTING_FILES |
            Ci.nsIWebBrowserPersist.PERSIST_FLAGS_NO_BASE_TAG_MODIFICATIONS |
            Ci.nsIWebBrowserPersist
              .PERSIST_FLAGS_AUTODETECT_APPLY_CONVERSION |
            Ci.nsIWebBrowserPersist.PERSIST_FLAGS_FROM_CACHE;

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

          persist.saveDocument(
            browser.contentDocument,
            pageFile,
            dataDir,
            null, // output content type (auto)
            Ci.nsIWebBrowserPersist.ENCODE_FLAGS_ENCODE_BASIC_ENTITIES,
            0 // wrap column
          );
        }),
        SAVE_TIMEOUT_MS
      );

      // Track the hibernation.
      gHibernatedBrowsers.set(browser.permanentKey, metadata);

      return { success: true, tabId };
    } catch (ex) {
      // Clean up partial files on failure.
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
   *
   * @param {XULBrowserElement} browser  The tab's linked browser element.
   * @param {string} tabId               The hibernation ID to restore from.
   * @returns {Promise<object>}  Resolves with the metadata object.
   */
  async restoreTab(browser, tabId) {
    let hibernationDir = getHibernationDir(tabId);

    let metadataPath = PathUtils.join(hibernationDir, "metadata.json");
    if (!(await IOUtils.exists(metadataPath))) {
      throw new Error(`Hibernation data not found for tabId: ${tabId}`);
    }

    let metadata = await IOUtils.readJSON(metadataPath);

    // Load the saved page from disk.
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

    // Check cache expiry and show notification if needed.
    if (isHibernationExpired(metadata)) {
      // Wait for the local file to finish loading before showing the bar.
      let onLoad = () => {
        browser.removeEventListener("load", onLoad, true);
        showExpiryNotification(browser, metadata.url, metadata.timestamp);
      };
      browser.addEventListener("load", onLoad, true);
    }

    // Update internal tracking.
    gHibernatedBrowsers.set(browser.permanentKey, metadata);

    return metadata;
  },

  /**
   * Check whether a browser is currently hibernated.
   *
   * @param {object} permanentKey  The browser's permanentKey.
   * @returns {boolean}
   */
  isHibernated(permanentKey) {
    return gHibernatedBrowsers.has(permanentKey);
  },

  /**
   * Retrieve the hibernation metadata for a browser.
   *
   * @param {object} permanentKey  The browser's permanentKey.
   * @returns {object|null}
   */
  getHibernationInfo(permanentKey) {
    return gHibernatedBrowsers.get(permanentKey) || null;
  },

  /**
   * Remove the hibernation tracking for a browser (e.g. after a full
   * network reload).
   *
   * @param {object} permanentKey
   */
  clearHibernation(permanentKey) {
    gHibernatedBrowsers.delete(permanentKey);
  },

  /**
   * Delete hibernation files for a specific tab.
   *
   * @param {string} tabId
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
   * Clean up hibernation directories older than HIBERNATION_CLEANUP_AGE_MS
   * that are not referenced by any currently open tab.
   *
   * This should be called once during browser startup.
   */
  async cleanupOldHibernations() {
    let root = getHibernationRoot();
    let exists = await IOUtils.exists(root);
    if (!exists) {
      return;
    }

    // Gather tab IDs of currently hibernated tabs across all windows.
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
      if (activeTabIds.has(tabId)) {
        continue;
      }

      let metadataPath = PathUtils.join(childPath, "metadata.json");
      try {
        let metadata = await IOUtils.readJSON(metadataPath);
        if (now - metadata.timestamp > HIBERNATION_CLEANUP_AGE_MS) {
          await IOUtils.remove(childPath, { recursive: true });
        }
      } catch (ex) {
        // Missing or corrupt metadata — remove the directory.
        try {
          await IOUtils.remove(childPath, { recursive: true });
        } catch (e) {
          /* ignore */
        }
      }
    }
  },
};
