/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * contextualIdentities WebExtension API — Container Tabs Management
 * (容器标签页管理 WebExtension API)
 *
 * [English]
 * This file implements the browser.contextualIdentities API, which allows
 * WebExtensions to manage Firefox's Container Tabs (also known as "Contextual
 * Identities" or "Multi-Account Containers"). Containers provide isolated
 * browsing contexts with separate cookies, cache, and site data.
 *
 * Bug 1386673 Fix — Optional Permission with Read-Only Variant:
 *   Previously, the "contextualIdentities" permission was a no-prompt
 *   permission that any extension could claim, and requesting it would
 *   FORCEFULLY ENABLE the container feature for the user — even if the
 *   extension only needed to read container information (e.g., TreeStyleTab
 *   just wants to color-code tabs by container).
 *
 *   This fix introduces:
 *   1. Changed "contextualIdentities" from PermissionNoPrompt to
 *      OptionalPermissionNoPrompt — extensions must explicitly request it
 *   2. Added "contextualIdentities.readOnly" — a new permission that allows
 *      extensions to READ container info (get/query) without:
 *        a. Enabling the container feature on the user's behalf
 *        b. Being able to create/update/move/remove containers
 *   3. When containers are disabled and only readOnly permission is held,
 *      get() returns null and query() returns [] instead of throwing
 *
 * [中文]
 * 本文件实现了 browser.contextualIdentities API，允许 WebExtension 管理
 * Firefox 的容器标签页（也称为「上下文身份」或「多账户容器」）。容器提供了
 * 隔离的浏览上下文，具有独立的 Cookie、缓存和站点数据。
 *
 * Bug 1386673 修复 — 可选权限与只读变体：
 *   此前，"contextualIdentities" 权限是一个无需提示的权限，任何扩展都可以
 *   声明它，且请求该权限会强制为用户启用容器功能——即使扩展只需要读取容器
 *   信息（例如，TreeStyleTab 只想按容器对标签页进行颜色编码）。
 *
 *   本修复引入了：
 *   1. 将 "contextualIdentities" 从 PermissionNoPrompt 改为
 *      OptionalPermissionNoPrompt——扩展必须显式请求
 *   2. 新增 "contextualIdentities.readOnly"——一个新权限，允许扩展读取
 *      容器信息（get/query），而不会：
 *        a. 代替用户启用容器功能
 *        b. 能够创建/更新/移动/删除容器
 *   3. 当容器被禁用且仅持有 readOnly 权限时，get() 返回 null，
 *      query() 返回 [] 而不是抛出异常
 */

"use strict";

ChromeUtils.defineESModuleGetters(this, {
  ContextualIdentityService:
    "resource://gre/modules/ContextualIdentityService.sys.mjs",
});

/**
 * Lazy preference getter — tracks whether the container feature is enabled.
 * (惰性首选项获取器——跟踪容器功能是否已启用。)
 */
XPCOMUtils.defineLazyPreferenceGetter(
  this,
  "containersEnabled",
  "privacy.userContext.enabled"
);

var { ExtensionPreferencesManager } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionPreferencesManager.sys.mjs"
);

var { ExtensionError } = ExtensionUtils;

/**
 * Default preference values set when a container-managing extension is installed.
 * (安装容器管理扩展时设置的默认首选项值。)
 */
const CONTAINER_PREF_INSTALL_DEFAULTS = {
  "privacy.userContext.extension": undefined,
};

const CONTAINERS_ENABLED_SETTING_NAME = "privacy.containers";

/**
 * Valid container color names and their hex color codes.
 * (有效的容器颜色名称及其十六进制颜色代码。)
 */
const CONTAINER_COLORS = new Map([
  ["blue", "#37adff"],
  ["turquoise", "#00c79a"],
  ["green", "#51cd00"],
  ["yellow", "#ffcb00"],
  ["orange", "#ff9f00"],
  ["red", "#ff613d"],
  ["pink", "#ff4bda"],
  ["purple", "#af51f5"],
  ["toolbar", "#7c7c7d"],
]);

/**
 * Valid container icon names. Each corresponds to an SVG file in
 * resource://usercontext-content/.
 * (有效的容器图标名称。每个对应 resource://usercontext-content/ 中的一个 SVG 文件。)
 */
const CONTAINER_ICONS = new Set([
  "briefcase",
  "cart",
  "circle",
  "dollar",
  "fence",
  "fingerprint",
  "gift",
  "vacation",
  "food",
  "fruit",
  "pet",
  "tree",
  "chill",
]);

/**
 * Get the SVG icon URL for a container icon name.
 * Throws ExtensionError if the icon name is invalid.
 *
 * 获取容器图标名称对应的 SVG 图标 URL。如果图标名称无效则抛出 ExtensionError。
 */
function getContainerIcon(iconName) {
  if (!CONTAINER_ICONS.has(iconName)) {
    throw new ExtensionError(`Invalid icon ${iconName} for container`);
  }
  return `resource://usercontext-content/${iconName}.svg`;
}

/**
 * Get the hex color code for a container color name.
 * Throws ExtensionError if the color name is invalid.
 *
 * 获取容器颜色名称对应的十六进制颜色代码。如果颜色名称无效则抛出 ExtensionError。
 */
function getContainerColor(colorName) {
  if (!CONTAINER_COLORS.has(colorName)) {
    throw new ExtensionError(`Invalid color name ${colorName} for container`);
  }
  return CONTAINER_COLORS.get(colorName);
}

/**
 * Convert an internal ContextualIdentityService identity object to the
 * WebExtension API format that extensions receive.
 *
 * 将内部 ContextualIdentityService 身份对象转换为扩展接收的 WebExtension API 格式。
 *
 * @param {object} identity  Internal identity object (内部身份对象)
 * @returns {object} API-formatted identity (API 格式的身份)
 */
const convertIdentity = identity => {
  let result = {
    name: ContextualIdentityService.getUserContextLabel(identity.userContextId),
    icon: identity.icon,
    iconUrl: getContainerIcon(identity.icon),
    color: identity.color,
    colorCode: getContainerColor(identity.color),
    cookieStoreId: getCookieStoreIdForContainer(identity.userContextId),
  };

  return result;
};

/**
 * Check that the container feature is enabled globally. Throws if not.
 * (检查容器功能是否全局启用。如果未启用则抛出异常。)
 */
const checkAPIEnabled = () => {
  if (!containersEnabled) {
    throw new ExtensionError("Contextual identities are currently disabled");
  }
};

/**
 * [Bug 1386673] Check that the extension has the FULL "contextualIdentities"
 * permission, which is required for write operations (create, update, move,
 * remove). The readOnly permission only grants get/query access.
 *
 * [Bug 1386673] 检查扩展是否拥有完整的 "contextualIdentities" 权限，
 * 写操作（创建、更新、移动、删除）需要该权限。readOnly 权限仅授予
 * get/query 访问权。
 *
 * @param {Extension} extension  The extension object (扩展对象)
 * @throws {ExtensionError} If write permission is missing (如果缺少写权限则抛出)
 */
const checkWritePermission = extension => {
  if (!extension.hasPermission("contextualIdentities")) {
    throw new ExtensionError(
      "The contextualIdentities permission is required to modify containers"
    );
  }
};

/**
 * Convert an identity from an observer notification (nsISupports wrapped)
 * to the API format. Returns null if the identity has invalid icon/color.
 *
 * 将来自观察者通知（nsISupports 包装）的身份转换为 API 格式。
 * 如果身份具有无效的图标/颜色则返回 null。
 */
const convertIdentityFromObserver = wrappedIdentity => {
  let identity = wrappedIdentity.wrappedJSObject;
  let iconUrl, colorCode;
  try {
    iconUrl = getContainerIcon(identity.icon);
    colorCode = getContainerColor(identity.color);
  } catch (e) {
    return null;
  }

  let result = {
    name: identity.name,
    icon: identity.icon,
    iconUrl,
    color: identity.color,
    colorCode,
    cookieStoreId: getCookieStoreIdForContainer(identity.userContextId),
  };

  return result;
};

/**
 * Register the container-enabled preference setting with the
 * ExtensionPreferencesManager so it can be managed per-extension.
 *
 * 在 ExtensionPreferencesManager 中注册容器启用的首选项设置，以便
 * 可以按扩展管理。
 */
ExtensionPreferencesManager.addSetting(CONTAINERS_ENABLED_SETTING_NAME, {
  prefNames: Object.keys(CONTAINER_PREF_INSTALL_DEFAULTS),

  setCallback(value) {
    if (value !== true) {
      return {
        ...CONTAINER_PREF_INSTALL_DEFAULTS,
        "privacy.userContext.extension": value,
      };
    }
    return {};
  },
});

/**
 * The contextualIdentities API class — implements the browser.contextualIdentities
 * namespace for WebExtensions.
 *
 * contextualIdentities API 类——为 WebExtension 实现
 * browser.contextualIdentities 命名空间。
 *
 * Permission model (权限模型):
 *   - "contextualIdentities" (full) — enables container feature + read/write access
 *     (完整权限——启用容器功能 + 读写访问)
 *   - "contextualIdentities.readOnly" — read-only access, does NOT enable containers
 *     (只读访问，不启用容器)
 *
 * See Bug 1386673 for the rationale behind the readOnly permission.
 * (关于 readOnly 权限的原因，请参阅 Bug 1386673。)
 */
this.contextualIdentities = class extends ExtensionAPIPersistent {
  /**
   * Create an event registrar for container identity change events.
   * (为容器身份更改事件创建事件注册器。)
   */
  eventRegistrar(eventName) {
    return ({ fire }) => {
      let observer = subject => {
        let convertedIdentity = convertIdentityFromObserver(subject);
        if (convertedIdentity) {
          fire.async({ contextualIdentity: convertedIdentity });
        }
      };

      Services.obs.addObserver(observer, eventName);
      return {
        unregister() {
          Services.obs.removeObserver(observer, eventName);
        },
        convert(_fire) {
          fire = _fire;
        },
      };
    };
  }

  /**
   * Persistent events that survive background page suspension.
   * (在后台页面挂起后仍然存活的持久事件。)
   */
  PERSISTENT_EVENTS = {
    onCreated: this.eventRegistrar("contextual-identity-created"),
    onUpdated: this.eventRegistrar("contextual-identity-updated"),
    onRemoved: this.eventRegistrar("contextual-identity-deleted"),
  };

  /**
   * Called when the extension starts up (install or browser launch).
   * 在扩展启动时调用（安装或浏览器启动时）。
   *
   * [Bug 1386673] CRITICAL CHANGE: Only the full "contextualIdentities"
   * permission enables the container feature. The "contextualIdentities.readOnly"
   * permission does NOT enable containers, allowing extensions like TreeStyleTab
   * to read container info without forcing the feature on users who haven't
   * opted in.
   *
   * [Bug 1386673] 关键变更：只有完整的 "contextualIdentities" 权限才会
   * 启用容器功能。"contextualIdentities.readOnly" 权限不会启用容器，
   * 允许像 TreeStyleTab 这样的扩展读取容器信息，而不会强制未选择的用户
   * 启用该功能。
   */
  onStartup() {
    let { extension } = this;

    // Only enable the container feature when the full contextualIdentities
    // permission is granted. The readOnly permission should NOT enable
    // containers, allowing extensions like TreeStyleTab to read container
    // info without forcing the feature on users (Bug 1386673).
    // 仅在授予完整的 contextualIdentities 权限时启用容器功能。readOnly
    // 权限不应启用容器，允许像 TreeStyleTab 这样的扩展读取容器信息而不
    // 强制用户使用该功能（Bug 1386673）。
    if (extension.hasPermission("contextualIdentities")) {
      // Turn on contextual identities, and never turn it off.  We handle
      // this here to ensure prefs are set when an addon is enabled.
      // 启用上下文身份功能，且永不关闭。我们在此处理以确保在启用
      // 插件时设置首选项。
      Services.prefs.setBoolPref("privacy.userContext.enabled", true);
      Services.prefs.setBoolPref("privacy.userContext.ui.enabled", true);

      ExtensionPreferencesManager.setSetting(
        extension.id,
        CONTAINERS_ENABLED_SETTING_NAME,
        extension.id
      );
    }
  }

  /**
   * Return the API object that extensions interact with.
   * 返回扩展交互的 API 对象。
   *
   * [Bug 1386673] The API checks two permission levels:
   *   - hasFullPermission: can read AND write containers (create/update/move/remove)
   *   - hasReadOnlyPermission: can only read containers (get/query)
   *
   * [Bug 1386673] API 检查两个权限级别：
   *   - hasFullPermission：可以读取和写入容器（创建/更新/移动/删除）
   *   - hasReadOnlyPermission：只能读取容器（get/query）
   */
  getAPI(context) {
    let { extension } = context;

    // [Bug 1386673] Determine permission level for this extension.
    // [Bug 1386673] 确定此扩展的权限级别。
    let hasFullPermission = extension.hasPermission("contextualIdentities");
    let hasReadOnlyPermission =
      extension.hasPermission("contextualIdentities.readOnly");

    let self = {
      contextualIdentities: {
        /**
         * Get a single container by its cookie store ID.
         * 通过 cookie 存储 ID 获取单个容器。
         *
         * [Bug 1386673] With readOnly permission and containers disabled,
         * returns null instead of throwing — allows graceful degradation.
         * [Bug 1386673] 当持有 readOnly 权限且容器被禁用时，返回 null
         * 而非抛出异常——允许优雅降级。
         */
        async get(cookieStoreId) {
          // With readOnly permission and containers disabled, return null
          // instead of throwing, so extensions can gracefully handle this.
          // 当持有 readOnly 权限且容器被禁用时，返回 null 而非抛出异常，
          // 以便扩展可以优雅地处理这种情况。
          if (!containersEnabled) {
            if (hasReadOnlyPermission && !hasFullPermission) {
              return null;
            }
            checkAPIEnabled();
          }
          let containerId = getContainerForCookieStoreId(cookieStoreId);
          if (!containerId) {
            throw new ExtensionError(
              `Invalid contextual identity: ${cookieStoreId}`
            );
          }

          let identity =
            ContextualIdentityService.getPublicIdentityFromId(containerId);
          return convertIdentity(identity);
        },

        /**
         * Query containers, optionally filtering by name.
         * 查询容器，可选按名称过滤。
         *
         * [Bug 1386673] With readOnly permission and containers disabled,
         * returns [] instead of throwing (Bug 1386673).
         * [Bug 1386673] 当持有 readOnly 权限且容器被禁用时，返回 []
         * 而非抛出异常。
         */
        async query(details) {
          // With readOnly permission and containers disabled, return empty
          // array instead of throwing (Bug 1386673).
          // 当持有 readOnly 权限且容器被禁用时，返回空数组而非抛出异常
          // （Bug 1386673）。
          if (!containersEnabled) {
            if (hasReadOnlyPermission && !hasFullPermission) {
              return [];
            }
            checkAPIEnabled();
          }
          let identities = [];
          ContextualIdentityService.getPublicIdentities().forEach(identity => {
            if (
              details.name &&
              ContextualIdentityService.getUserContextLabel(
                identity.userContextId
              ) != details.name
            ) {
              return;
            }

            identities.push(convertIdentity(identity));
          });

          return identities;
        },

        /**
         * Create a new container. Requires full permission.
         * 创建新容器。需要完整权限。
         *
         * [Bug 1386673] checkWritePermission() ensures readOnly extensions
         * cannot create containers.
         * [Bug 1386673] checkWritePermission() 确保 readOnly 扩展不能创建容器。
         */
        async create(details) {
          checkWritePermission(extension);
          checkAPIEnabled();
          // Lets prevent making containers that are not valid
          // 防止创建无效的容器
          getContainerIcon(details.icon);
          getContainerColor(details.color);

          let identity = ContextualIdentityService.create(
            details.name,
            details.icon,
            details.color
          );
          return convertIdentity(identity);
        },

        /**
         * Update an existing container. Requires full permission.
         * 更新现有容器。需要完整权限。
         *
         * [Bug 1386673] checkWritePermission() ensures readOnly extensions
         * cannot modify containers.
         * [Bug 1386673] checkWritePermission() 确保 readOnly 扩展不能修改容器。
         */
        async update(cookieStoreId, details) {
          checkWritePermission(extension);
          checkAPIEnabled();
          let containerId = getContainerForCookieStoreId(cookieStoreId);
          if (!containerId) {
            throw new ExtensionError(
              `Invalid contextual identity: ${cookieStoreId}`
            );
          }

          let identity =
            ContextualIdentityService.getPublicIdentityFromId(containerId);
          if (!identity) {
            throw new ExtensionError(
              `Invalid contextual identity: ${cookieStoreId}`
            );
          }

          if (details.name !== null) {
            identity.name = details.name;
          }

          if (details.color !== null) {
            getContainerColor(details.color);
            identity.color = details.color;
          }

          if (details.icon !== null) {
            getContainerIcon(details.icon);
            identity.icon = details.icon;
          }

          if (
            !ContextualIdentityService.update(
              identity.userContextId,
              identity.name,
              identity.icon,
              identity.color
            )
          ) {
            throw new ExtensionError(
              `Contextual identity failed to update: ${cookieStoreId}`
            );
          }

          return convertIdentity(identity);
        },

        /**
         * Move containers to a new position. Requires full permission.
         * 将容器移动到新位置。需要完整权限。
         */
        async move(cookieStoreIds, position) {
          checkWritePermission(extension);
          checkAPIEnabled();
          if (!Array.isArray(cookieStoreIds)) {
            cookieStoreIds = [cookieStoreIds];
          }

          if (!cookieStoreIds.length) {
            return;
          }

          const totalIds =
            ContextualIdentityService.getPublicIdentities().length;
          if (position < -1 || position > totalIds - cookieStoreIds.length) {
            throw new ExtensionError(`Moving to invalid position ${position}`);
          }

          let userContextIds = [];
          cookieStoreIds.forEach((cookieStoreId, index) => {
            if (cookieStoreIds.indexOf(cookieStoreId) !== index) {
              throw new ExtensionError(
                `Duplicate contextual identity: ${cookieStoreId}`
              );
            }

            let containerId = getContainerForCookieStoreId(cookieStoreId);
            if (!containerId) {
              throw new ExtensionError(
                `Invalid contextual identity: ${cookieStoreId}`
              );
            }

            userContextIds.push(containerId);
          });

          if (!ContextualIdentityService.move(userContextIds, position)) {
            throw new ExtensionError(
              `Contextual identities failed to move: ${cookieStoreIds}`
            );
          }
        },

        /**
         * Remove a container. Requires full permission.
         * 删除容器。需要完整权限。
         */
        async remove(cookieStoreId) {
          checkWritePermission(extension);
          checkAPIEnabled();
          let containerId = getContainerForCookieStoreId(cookieStoreId);
          if (!containerId) {
            throw new ExtensionError(
              `Invalid contextual identity: ${cookieStoreId}`
            );
          }

          let identity =
            ContextualIdentityService.getPublicIdentityFromId(containerId);
          if (!identity) {
            throw new ExtensionError(
              `Invalid contextual identity: ${cookieStoreId}`
            );
          }

          // We have to create the identity object before removing it.
          // 我们必须在删除之前创建身份对象。
          let convertedIdentity = convertIdentity(identity);

          if (!ContextualIdentityService.remove(identity.userContextId)) {
            throw new ExtensionError(
              `Contextual identity failed to remove: ${cookieStoreId}`
            );
          }

          return convertedIdentity;
        },

        /**
         * Event fired when a new container is created.
         * (创建新容器时触发的事件。)
         */
        onCreated: new EventManager({
          context,
          module: "contextualIdentities",
          event: "onCreated",
          extensionApi: this,
        }).api(),

        /**
         * Event fired when a container is updated.
         * (更新容器时触发的事件。)
         */
        onUpdated: new EventManager({
          context,
          module: "contextualIdentities",
          event: "onUpdated",
          extensionApi: this,
        }).api(),

        /**
         * Event fired when a container is removed.
         * (删除容器时触发的事件。)
         */
        onRemoved: new EventManager({
          context,
          module: "contextualIdentities",
          event: "onRemoved",
          extensionApi: this,
        }).api(),
      },
    };

    return self;
  }
};
