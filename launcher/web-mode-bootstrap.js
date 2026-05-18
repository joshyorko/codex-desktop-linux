(function () {
  const bridgeUrl = `${window.location.origin}/__codex/bridge`;
  const bridgeToken = window.__CODEX_WEB_TOKEN__ || "";
  const localHostId = "local";
  const sessionKey = "codex-desktop-web-session-id";
  const vscodeStateKey = "codex-desktop-web-vscode-state";
  const navigationStateKey = "codex-desktop-web-navigation-state";
  const cssPreloadErrorPrefix = "Unable to preload CSS for ";
  const noHostRpcFallback = Symbol("no-host-rpc-fallback");
  const localHttpFetchProxyPrefixes = [
    "/accounts/",
    "/api/",
    "/backend-api/",
    "/beacons/",
    "/checkout_pricing_config/",
    "/files/",
    "/oauth/",
    "/subscriptions/",
    "/wham/",
  ];
  const hostFetchAppServerRpcMethods = new Map([
    ["batch-write-config-value", "config/batchWrite"],
    ["batch-write-config-value-for-host", "config/batchWrite"],
    ["get-config-requirements-for-host", "configRequirements/read"],
    ["install-plugin", "plugin/install"],
    ["list-experimental-features", "experimentalFeature/list"],
    ["list-hooks-for-host", "hooks/list"],
    ["list-mcp-server-status", "mcpServerStatus/list"],
    ["list-models-for-host", "model/list"],
    ["list-plugins", "plugin/list"],
    ["list-skills-for-host", "skills/list"],
    ["read-config-for-host", "config/read"],
    ["read-mcp-resource", "mcpServer/resource/read"],
    ["read-plugin", "plugin/read"],
    ["read-plugin-skill", "plugin/skill/read"],
    ["remove-marketplace", "marketplace/remove"],
    ["uninstall-plugin", "plugin/uninstall"],
    ["upgrade-marketplaces", "marketplace/upgrade"],
    ["write-config-value", "config/value/write"],
    ["write-skill-config", "skills/config/write"],
  ]);
  const browserUseStateKey = "browser-use-origin-state";
  const activeTurnRecoveryTimeoutMs = 90_000;
  const activeTurnRecoveryInitialDelayMs = 0;
  const activeTurnRecoveryPollMs = 1_000;
  const eventStreamReconnectMaxDelayMs = 5_000;
  const defaultBrowserUseState = {
    approvalMode: "alwaysAsk",
    historyApprovalMode: "alwaysAsk",
    downloadApprovalMode: "alwaysAsk",
    uploadApprovalMode: "alwaysAsk",
    allowedOrigins: [],
    deniedOrigins: [],
    allowedDownloadOrigins: [],
    deniedDownloadOrigins: [],
    allowedUploadOrigins: [],
    deniedUploadOrigins: [],
  };

  const fallbackState = {
    persistedAtoms: {},
    globalState: {},
    sharedObjects: {
      remote_connections: [],
      remote_control_connections: [],
      host_config: {
        id: localHostId,
        display_name: "Local",
        kind: "local",
      },
    },
  };

  let health = null;
  let webState = structuredCloneSafe(fallbackState);
  let persistTimer = null;
  const activeTurns = new Map();
  let eventStream = null;
  let eventStreamReconnectTimer = null;
  let eventStreamReconnectDelayMs = 250;
  let dictationRecognition = null;

  installCssPreloadErrorGuard();
  installNavigationStatePersistence();

  function installCssPreloadErrorGuard() {
    window.addEventListener("vite:preloadError", (event) => {
      const failedUrl = cssPreloadErrorUrl(event.payload);
      if (!failedUrl || failedUrl.origin !== window.location.origin) {
        return;
      }
      if (!failedUrl.pathname.startsWith("/assets/") || !failedUrl.pathname.endsWith(".css")) {
        return;
      }

      event.preventDefault();
      console.warn("[codex-web] ignored same-origin CSS preload failure", failedUrl.pathname);
    });
  }

  function cssPreloadErrorUrl(payload) {
    const message = payload instanceof Error ? payload.message : String(payload ?? "");
    const preloadMessage = message.startsWith("Error: ") ? message.slice("Error: ".length) : message;
    if (!preloadMessage.startsWith(cssPreloadErrorPrefix)) {
      return null;
    }

    try {
      return new URL(preloadMessage.slice(cssPreloadErrorPrefix.length), window.location.origin);
    } catch {
      return null;
    }
  }

  function structuredCloneSafe(value) {
    try {
      return window.structuredClone(value);
    } catch {
      return JSON.parse(JSON.stringify(value));
    }
  }

  async function request(method, params) {
    const response = await fetch(bridgeUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "x-codex-web-token": bridgeToken },
      body: JSON.stringify({ method, params: params ?? null }),
    });
    if (!response.ok) {
      throw new Error(`Codex web bridge request failed: ${response.status}`);
    }
    return response.json();
  }

  const ready = (async () => {
    try {
      const [stateResponse, healthResponse] = await Promise.all([
        request("webState.read"),
        request("health.read"),
      ]);
      webState = {
        ...structuredCloneSafe(fallbackState),
        ...(stateResponse.result ?? {}),
        persistedAtoms: {
          ...fallbackState.persistedAtoms,
          ...(stateResponse.result?.persistedAtoms ?? {}),
        },
        globalState: {
          ...fallbackState.globalState,
          ...(stateResponse.result?.globalState ?? {}),
        },
        sharedObjects: {
          ...fallbackState.sharedObjects,
          ...(stateResponse.result?.sharedObjects ?? {}),
        },
      };
      health = healthResponse.result ?? null;
      refreshWorkspaceObjects();
    } catch (error) {
      console.warn("[codex-web] failed to read persisted web state", error);
      refreshWorkspaceObjects();
    }
  })();

  function refreshWorkspaceObjects() {
    const workspace = defaultWorkspaceRoot();
    const codexHome = health?.codex_home || "~/.codex";
    webState.sharedObjects.host_config = {
      id: localHostId,
      display_name: "Local",
      kind: "local",
    };
    webState.globalState["active-workspace-roots"] ??= { roots: [workspace] };
    webState.globalState["electron-saved-workspace-roots"] ??= { roots: [workspace] };
    webState.globalState["workspace-root-options"] ??= { roots: [workspace] };
    webState.globalState["codex-home"] ??= codexHome;
    webState.globalState["home-directory"] ??= workspace;
  }

  function defaultWorkspaceRoot() {
    return health?.workspace || "/workspace";
  }

  function coerceWorkspaceRoots(value) {
    const roots = Array.isArray(value?.roots) ? value.roots : Array.isArray(value) ? value : [];
    return Array.from(
      new Set(
        roots
          .filter((root) => typeof root === "string")
          .map((root) => root.trim())
          .filter(Boolean),
      ),
    );
  }

  function savedWorkspaceRoots() {
    const roots = coerceWorkspaceRoots(webState.globalState["workspace-root-options"]);
    return roots.length > 0 ? roots : [defaultWorkspaceRoot()];
  }

  function emitWorkspaceStateUpdated(keys = [
    "active-workspace-roots",
    "electron-saved-workspace-roots",
    "workspace-root-options",
  ]) {
    queuePersist();
    emit({ type: "global-state-updated", keys });
  }

  function setWorkspaceRootState(roots, activeRoots = null) {
    const nextRoots = coerceWorkspaceRoots({ roots });
    const workspaceRoots = nextRoots.length > 0 ? nextRoots : [defaultWorkspaceRoot()];
    const active = activeRoots == null ? coerceWorkspaceRoots(webState.globalState["active-workspace-roots"]) : coerceWorkspaceRoots({ roots: activeRoots });
    webState.globalState["workspace-root-options"] = { roots: workspaceRoots };
    webState.globalState["electron-saved-workspace-roots"] = { roots: workspaceRoots };
    webState.globalState["active-workspace-roots"] = { roots: active.filter((root) => workspaceRoots.includes(root)) };
    emitWorkspaceStateUpdated();
    return {
      workspaceRootOptions: webState.globalState["workspace-root-options"],
      activeWorkspaceRoots: webState.globalState["active-workspace-roots"],
    };
  }

  async function validateWorkspaceRoot(root) {
    const response = await request("workspace.rootMetadata", { root });
    const metadata = response.result ?? {};
    if (!metadata.isDirectory) {
      throw new Error(`${root} is not a directory`);
    }
    return metadata.path || root;
  }

  async function addWorkspaceRoot(root, { setActive = true } = {}) {
    const validatedRoot = await validateWorkspaceRoot(root);
    const roots = savedWorkspaceRoots();
    if (!roots.includes(validatedRoot)) {
      roots.push(validatedRoot);
    }
    return {
      root: validatedRoot,
      ...setWorkspaceRootState(roots, setActive ? [validatedRoot] : null),
    };
  }

  async function promptForWorkspaceRoot() {
    try {
      const response = await request("workspace.selectDirectory", { initialRoot: defaultWorkspaceRoot() });
      const selected = response.result ?? {};
      if (selected.path) {
        return selected.path;
      }
    } catch (error) {
      console.warn("[codex-web] native folder picker unavailable", error);
    }

    const root = window.prompt?.("Folder path", defaultWorkspaceRoot());
    return typeof root === "string" ? root.trim() : "";
  }

  function reportWorkspaceRootError(error) {
    const message = error instanceof Error ? error.message : String(error);
    window.alert?.(`Unable to use that folder: ${message}`);
    console.warn("[codex-web] workspace root update failed", error);
    return { ok: false, error: message };
  }

  function webModeHostRpcFallback(method) {
    switch (method) {
      case "list-automations":
        return { items: [] };
      case "get-is-conversation-archiving-for-host":
        return false;
      case "hotkey-window-hotkey-state":
        return { configuredHotkey: null };
      default:
        return noHostRpcFallback;
    }
  }

  function browserUseState() {
    const saved = webState.globalState?.[browserUseStateKey];
    if (saved == null || typeof saved !== "object" || Array.isArray(saved)) {
      return structuredCloneSafe(defaultBrowserUseState);
    }
    return {
      ...structuredCloneSafe(defaultBrowserUseState),
      ...saved,
    };
  }

  function writeBrowserUseState(nextState) {
    webState.globalState[browserUseStateKey] = nextState;
    queuePersist();
    return nextState;
  }

  function browserUseOriginListName(kind, transferKind = null) {
    const prefix = kind === "allowed" ? "allowed" : "denied";
    if (transferKind === "download") {
      return `${prefix}DownloadOrigins`;
    }
    if (transferKind === "upload") {
      return `${prefix}UploadOrigins`;
    }
    return `${prefix}Origins`;
  }

  function updateBrowserUseOrigin(params, add) {
    const targetOrigin = typeof params.targetOrigin === "string" ? params.targetOrigin.trim() : "";
    if (targetOrigin.length === 0) {
      return browserUseState();
    }
    const state = browserUseState();
    const listName = browserUseOriginListName(params.kind, params.transferKind);
    const existing = Array.isArray(state[listName]) ? state[listName] : [];
    const nextList = add
      ? Array.from(new Set([...existing, targetOrigin]))
      : existing.filter((origin) => origin !== targetOrigin);
    return writeBrowserUseState({ ...state, [listName]: nextList });
  }

  function updateBrowserUseApprovalMode(params) {
    const state = browserUseState();
    return writeBrowserUseState({ ...state, approvalMode: params.approvalMode || state.approvalMode });
  }

  function updateBrowserUseHistoryApprovalMode(params) {
    const state = browserUseState();
    return writeBrowserUseState({ ...state, historyApprovalMode: params.approvalMode || state.historyApprovalMode });
  }

  function updateBrowserUseFileTransferApprovalMode(params) {
    const state = browserUseState();
    const key = params.kind === "upload" ? "uploadApprovalMode" : "downloadApprovalMode";
    return writeBrowserUseState({ ...state, [key]: params.approvalMode || state[key] });
  }

  function queuePersist() {
    window.clearTimeout(persistTimer);
    persistTimer = window.setTimeout(() => {
      request("webState.write", { state: webState }).catch((error) => {
        console.warn("[codex-web] failed to persist web state", error);
      });
    }, 150);
  }

  function emit(message) {
    window.postMessage(message, window.location.origin);
  }

  function emitAppServerNotification(method, params = {}) {
    if (typeof method !== "string" || method.length === 0) {
      return;
    }
    emit({
      type: "mcp-notification",
      hostId: localHostId,
      method,
      params: params ?? {},
    });
  }

  function activeThreadIdFrom(value) {
    if (typeof value?.threadId === "string" && value.threadId.length > 0) {
      return value.threadId;
    }
    if (typeof value?.thread?.id === "string" && value.thread.id.length > 0) {
      return value.thread.id;
    }
    if (typeof value?.id === "string" && value.id.length > 0) {
      return value.id;
    }
    return null;
  }

  function activeTurnIdFrom(value) {
    if (typeof value?.turnId === "string" && value.turnId.length > 0) {
      return value.turnId;
    }
    if (typeof value?.turn?.id === "string" && value.turn.id.length > 0) {
      return value.turn.id;
    }
    if (typeof value?.id === "string" && value.id.length > 0) {
      return value.id;
    }
    return null;
  }

  function normalizeTurnStatus(status) {
    if (typeof status === "string") {
      return status.replaceAll("_", "").toLowerCase();
    }
    if (typeof status?.type === "string") {
      return status.type.replaceAll("_", "").toLowerCase();
    }
    return "";
  }

  function isTerminalTurnStatus(status) {
    return ["completed", "failed", "cancelled", "canceled", "interrupted"].includes(normalizeTurnStatus(status));
  }

  function turnListFromResult(result) {
    const turns = result?.turns ?? result?.data ?? result?.items ?? [];
    return Array.isArray(turns) ? turns : [];
  }

  function emitRecoveredTurn(threadId, turn) {
    const turnId = activeTurnIdFrom(turn);
    if (!threadId || !turnId) {
      return;
    }
    emitAppServerNotification("turn/started", {
      threadId,
      turn: {
        id: turnId,
        status: turn.status ?? "inProgress",
        durationMs: turn.durationMs ?? null,
        error: turn.error ?? null,
      },
    });
    for (const item of Array.isArray(turn.items) ? turn.items : []) {
      if (item && typeof item === "object") {
        emitAppServerNotification("item/completed", {
          threadId,
          turnId,
          item,
        });
      }
    }
    if (isTerminalTurnStatus(turn.status)) {
      emitAppServerNotification("turn/completed", {
        threadId,
        turn: {
          id: turnId,
          status: turn.status,
          durationMs: turn.durationMs ?? null,
          error: turn.error ?? null,
        },
      });
      emitAppServerNotification("thread/status/changed", {
        threadId,
        status: { type: "idle" },
      });
    }
  }

  function trackActiveTurn(threadId, turnId) {
    if (!threadId || !turnId) {
      return;
    }
    const existing = activeTurns.get(threadId);
    if (existing?.timer != null) {
      window.clearTimeout(existing.timer);
    }
    activeTurns.set(threadId, {
      threadId,
      turnId,
      startedAt: Date.now(),
      timer: window.setTimeout(() => recoverActiveTurn(threadId), activeTurnRecoveryInitialDelayMs),
    });
  }

  async function recoverConversationTurn(threadId, turnId = null) {
    if (typeof threadId !== "string" || threadId.length === 0) {
      return null;
    }
    const result = await requestAppServerRpc("thread/turns/list", {
      threadId,
      cursor: null,
      limit: 10,
    });
    const turns = turnListFromResult(result);
    const matchingTurn = (turnId ? turns.find((turn) => activeTurnIdFrom(turn) === turnId) : null) ?? turns.at(-1);
    if (!matchingTurn) {
      return null;
    }
    emitRecoveredTurn(threadId, matchingTurn);
    if (isTerminalTurnStatus(matchingTurn.status)) {
      activeTurns.delete(threadId);
    }
    return matchingTurn;
  }

  async function recoverActiveTurn(threadId) {
    const tracked = activeTurns.get(threadId);
    if (!tracked) {
      return;
    }
    try {
      const matchingTurn = await recoverConversationTurn(threadId, tracked.turnId);
      if (matchingTurn && isTerminalTurnStatus(matchingTurn.status)) {
        return;
      }
    } catch (error) {
      console.warn("[codex-web] active turn recovery failed", error);
    }

    if (Date.now() - tracked.startedAt >= activeTurnRecoveryTimeoutMs) {
      activeTurns.delete(threadId);
      return;
    }
    tracked.timer = window.setTimeout(() => recoverActiveTurn(threadId), activeTurnRecoveryPollMs);
  }

  function recoverTrackedActiveTurns() {
    for (const threadId of activeTurns.keys()) {
      const tracked = activeTurns.get(threadId);
      if (tracked?.timer != null) {
        window.clearTimeout(tracked.timer);
      }
      recoverActiveTurn(threadId);
    }
  }

  function successFetch(message, body, status = 200, headers = {}) {
    emit({
      type: "fetch-response",
      hostId: message.hostId || localHostId,
      requestId: message.requestId,
      responseType: "success",
      status,
      headers: {
        "content-type": "application/json",
        ...headers,
      },
      bodyJsonString: JSON.stringify(body ?? {}),
    });
  }

  function errorFetch(message, error, status = 500) {
    emit({
      type: "fetch-response",
      hostId: message.hostId || localHostId,
      requestId: message.requestId,
      responseType: "error",
      status,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  function parseFetchBody(message) {
    if (typeof message.body !== "string" || message.body.length === 0) {
      return null;
    }
    try {
      return JSON.parse(message.body);
    } catch {
      return message.body;
    }
  }

  function codexMethodFromUrl(url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "vscode:" && parsed.hostname === "codex") {
        return parsed.pathname.replace(/^\//, "");
      }
    } catch {
      // fall through
    }
    const marker = "vscode://codex/";
    return typeof url === "string" && url.startsWith(marker) ? url.slice(marker.length) : null;
  }

  function localHttpPathFromUrl(url) {
    try {
      const parsed = new URL(url, window.location.origin);
      if (parsed.origin !== window.location.origin) {
        return null;
      }
      return `${parsed.pathname}${parsed.search}`;
    } catch {
      return null;
    }
  }

  function shouldProxyLocalHttpFetch(url) {
    const path = localHttpPathFromUrl(url);
    return path != null && localHttpFetchProxyPrefixes.some((prefix) => path.startsWith(prefix));
  }

  function base64ToUtf8(base64) {
    if (typeof base64 !== "string") {
      return "";
    }
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  async function proxyLocalHttpFetch(message) {
    const path = localHttpPathFromUrl(message.url);
    if (path == null) {
      throw new Error(`Cannot proxy non-local web-mode fetch: ${message.url}`);
    }
    const response = await fetch(path, {
      method: message.method || "GET",
      headers: message.headers ?? {},
      body: message.body,
    });
    const text = await response.text();
    const body = text.length === 0 ? {} : JSON.parse(text);
    const headers = Object.fromEntries(response.headers.entries());
    successFetch(message, body, response.status, headers);
  }

  async function readHostFile(params) {
    const response = await request("appServer.rpc", {
      method: "fs/readFile",
      params: {
        path: params.path,
        hostId: params.hostId || localHostId,
      },
    });
    return response.result ?? {};
  }

  async function requestAppServerRpc(method, params, timeoutMs) {
    const response = await request("appServer.rpc", {
      method,
      params: params ?? {},
      timeoutMs,
    });
    return response.result;
  }

  function defaultProjectlessOutputDirectory() {
    const homeDirectory = webState.globalState?.["home-directory"];
    return typeof homeDirectory === "string" && homeDirectory.trim().length > 0
      ? homeDirectory
      : defaultWorkspaceRoot();
  }

  function normalizeConversationStartParams(params = {}) {
    const cwd = typeof params.cwd === "string" && params.cwd.trim().length > 0
      ? params.cwd
      : defaultWorkspaceRoot();
    const workspaceRoots = coerceWorkspaceRoots(params.workspaceRoots ?? params.workspace_roots);
    const normalized = {
      ...params,
      hostId: params.hostId || localHostId,
      cwd,
      workspaceKind: params.workspaceKind || params.workspace_kind || "project",
      workspaceRoots: workspaceRoots.length > 0 ? workspaceRoots : [cwd],
    };
    if (
      normalized.workspaceKind === "projectless" &&
      (typeof normalized.projectlessOutputDirectory !== "string" ||
        normalized.projectlessOutputDirectory.trim().length === 0)
    ) {
      normalized.projectlessOutputDirectory = defaultProjectlessOutputDirectory();
    }
    return normalized;
  }

  async function startConversation(params = {}) {
    const normalized = normalizeConversationStartParams(params);
    const threadResult = await requestAppServerRpc("thread/start", {
      cwd: normalized.cwd,
      approvalsReviewer: normalized.approvalsReviewer,
      model: normalized.model,
      serviceTier: normalized.serviceTier,
      threadSource: normalized.threadSource,
      sessionStartSource: normalized.sessionStartSource,
      permissions: normalized.permissions,
      sandbox: normalized.sandbox,
    });
    const thread = threadResult?.thread ?? threadResult;
    const conversationId = thread?.id ?? thread?.sessionId ?? null;
    if (conversationId) {
      emitAppServerNotification("thread/started", { thread });
    }
    const input = Array.isArray(normalized.input) ? normalized.input : [];
    let turnResult = null;
    if (conversationId && input.length > 0) {
      turnResult = await requestAppServerRpc("turn/start", {
        threadId: conversationId,
        input,
        cwd: normalized.cwd,
        model: normalized.model,
        effort: normalized.reasoningEffort ?? normalized.effort,
        approvalsReviewer: normalized.approvalsReviewer,
        permissions: normalized.permissions,
        sandboxPolicy: normalized.sandboxPolicy,
      });
      const turn = turnResult?.turn ?? turnResult;
      trackActiveTurn(conversationId, activeTurnIdFrom(turn));
    }
    return {
      resultType: "success",
      result: {
        conversationId,
        thread,
        turn: turnResult?.turn ?? null,
        projectlessOutputDirectory: normalized.projectlessOutputDirectory ?? null,
      },
    };
  }

  async function startFollowerTurn(params = {}) {
    const conversationId = params.conversationId ?? params.threadId;
    if (typeof conversationId !== "string" || conversationId.trim().length === 0) {
      return { resultType: "error", error: "missing-conversation-id" };
    }
    const turnStartParams = params.turnStartParams ?? {};
    const result = await requestAppServerRpc("turn/start", {
      ...turnStartParams,
      threadId: conversationId,
      input: Array.isArray(turnStartParams.input) ? turnStartParams.input : [],
    });
    trackActiveTurn(conversationId, activeTurnIdFrom(result?.turn ?? result));
    return { resultType: "success", result };
  }

  async function requestDesktopIpc(method, params, timeoutMs) {
    if (method === "start-conversation") {
      return await startConversation(params);
    }
    if (method === "thread-follower-start-turn") {
      return await startFollowerTurn(params);
    }
    return await requestAppServerRpc(method, params, timeoutMs);
  }

  async function writeAppServerMessage(message) {
    await request("appServer.write", { message });
  }

  async function readHostFileMetadata(params) {
    const response = await request("fs.metadata", {
      path: params.path,
      hostId: params.hostId || localHostId,
    });
    return response.result ?? {};
  }

  async function existingHostPaths(params) {
    const paths = Array.isArray(params.paths) ? params.paths : [];
    const existingPaths = [];
    for (const candidate of paths) {
      if (typeof candidate !== "string" || candidate.trim().length === 0) {
        continue;
      }
      try {
        const metadata = await readHostFileMetadata({
          hostId: params.hostId || localHostId,
          path: candidate,
        });
        if (metadata.path) {
          existingPaths.push(metadata.path);
        }
      } catch {
        // Missing paths are expected here; the caller only needs positives.
      }
    }
    return { existingPaths };
  }

  async function interruptConversation(conversationId, conversationState = null) {
    if (typeof conversationId !== "string" || conversationId.trim().length === 0) {
      return { interrupted: false, reason: "missing-conversation-id" };
    }
    const response = await request("conversation.interrupt", { conversationId, conversationState });
    return response.result ?? response;
  }

  function installNavigationStatePersistence() {
    const navigation = window.navigation;
    if (!navigation || typeof navigation.addEventListener !== "function") {
      return;
    }

    restoreNavigationState(navigation);

    const save = () => {
      try {
        const entry = navigation.currentEntry;
        if (!entry?.url) {
          return;
        }
        const url = new URL(entry.url, window.location.origin);
        if (url.origin !== window.location.origin) {
          return;
        }
        window.sessionStorage.setItem(
          navigationStateKey,
          JSON.stringify({
            url: `${url.pathname}${url.search}${url.hash}`,
            state: typeof entry.getState === "function" ? entry.getState() : null,
          }),
        );
      } catch {
        // Navigation state is a convenience only; routing must continue if it
        // cannot be serialized.
      }
    };

    navigation.addEventListener("currententrychange", save);
    navigation.addEventListener("navigatesuccess", save);
    window.addEventListener("pagehide", save);
  }

  function restoreNavigationState(navigation) {
    let saved;
    try {
      saved = JSON.parse(window.sessionStorage.getItem(navigationStateKey) || "null");
    } catch {
      saved = null;
    }
    if (!saved || typeof saved.url !== "string") {
      return;
    }

    try {
      const savedUrl = new URL(saved.url, window.location.origin);
      if (savedUrl.origin !== window.location.origin) {
        return;
      }
      const currentEntry = navigation.currentEntry;
      const currentUrl = new URL(currentEntry?.url || window.location.href, window.location.origin);
      const currentRoute = `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`;
      const explicitInitialRoute = document?.querySelector?.('meta[name="initial-route"]')?.getAttribute?.("content");
      if (explicitInitialRoute || (currentRoute !== "/" && currentRoute !== "/index.html")) {
        return;
      }
      if (typeof navigation.updateCurrentEntry === "function") {
        navigation.updateCurrentEntry({ state: saved.state ?? null });
      }
      if (currentRoute === saved.url) {
        return;
      }
      window.history.replaceState(saved.state ?? window.history.state, "", saved.url);
    } catch {
      // If the browser rejects the saved URL/state, leave the app on its
      // default route instead of blocking startup.
    }
  }

  async function handleFetch(message) {
    await ready;
    if (shouldProxyLocalHttpFetch(message.url)) {
      try {
        await proxyLocalHttpFetch(message);
      } catch (error) {
        errorFetch(message, error);
      }
      return;
    }
    const method = codexMethodFromUrl(message.url);
    const body = parseFetchBody(message);
    const params = body?.params ?? body ?? {};
    try {
      switch (method) {
        case "get-global-state": {
          successFetch(message, { value: webState.globalState?.[params.key] ?? null });
          return;
        }
        case "set-global-state": {
          webState.globalState[params.key] = params.value;
          queuePersist();
          successFetch(message, { ok: true });
          emit({ type: "global-state-updated", keys: [params.key] });
          return;
        }
        case "active-workspace-roots":
        case "electron-saved-workspace-roots":
        case "workspace-root-options": {
          successFetch(message, webState.globalState[method] ?? { roots: [defaultWorkspaceRoot()] });
          return;
        }
        case "codex-home":
        case "home-directory": {
          successFetch(message, webState.globalState[method] ?? null);
          return;
        }
        case "os-info": {
          successFetch(message, {
            platform: "linux",
            arch: navigator.userAgent.includes("aarch64") ? "arm64" : "x64",
            release: "",
          });
          return;
        }
        case "extension-info": {
          successFetch(message, {
            version: "0.0.0-devcontainer-web",
            extensionKind: "electron",
            devcontainerWebMode: true,
          });
          return;
        }
        case "is-copilot-api-available": {
          successFetch(message, { available: false });
          return;
        }
        case "git-origins": {
          successFetch(message, { origins: [] });
          return;
        }
        case "codex-command-keymap-state": {
          successFetch(message, { bindings: [] });
          return;
        }
        case "read-file": {
          const file = await readHostFile(params);
          const contentsBase64 = file.contentsBase64 ?? file.dataBase64 ?? "";
          successFetch(message, {
            ...file,
            contents: file.contents ?? base64ToUtf8(contentsBase64),
            contentsBase64,
          });
          return;
        }
        case "read-file-binary": {
          const file = await readHostFile(params);
          successFetch(message, {
            contentsBase64: file.contentsBase64 ?? file.dataBase64 ?? "",
          });
          return;
        }
        case "chrome-extension-installed-read": {
          const response = await request("chromeExtension.installed", {
            extensionId: params.extensionId,
          });
          successFetch(message, response.result ?? response);
          return;
        }
        case "interrupt-conversation": {
          successFetch(message, await interruptConversation(params.conversationId, params.conversationState));
          return;
        }
        case "thread-follower-interrupt-turn-for-host": {
          successFetch(message, {
            ok: true,
            ...(await interruptConversation(params.conversationId, params.conversationState)),
          });
          return;
        }
        case "node-repl-active-execs-kill": {
          successFetch(message, { failedCount: 0 });
          return;
        }
        case "mcp-codex-config": {
          successFetch(message, { config: {} });
          return;
        }
        case "read-file-metadata": {
          successFetch(message, await readHostFileMetadata(params));
          return;
        }
        case "set-default-model-config-for-host": {
          const prefix = params.profile ? `profiles.${params.profile}.` : "";
          successFetch(
            message,
            await requestAppServerRpc("config/batchWrite", {
              edits: [
                { keyPath: `${prefix}model`, value: params.model, mergeStrategy: "upsert" },
                {
                  keyPath: `${prefix}model_reasoning_effort`,
                  value: params.reasoningEffort,
                  mergeStrategy: "upsert",
                },
              ],
              filePath: null,
              expectedVersion: null,
              reloadUserConfig: true,
            }),
          );
          return;
        }
        case "set-experimental-feature-enablement-for-host":
        case "set-local-app-server-feature-enablement": {
          successFetch(
            message,
            await requestAppServerRpc("experimentalFeature/enablement/set", {
              ...params,
              enablement: params.enablement ?? params.enabled,
            }),
          );
          return;
        }
        case "browser-use-origin-state-read": {
          successFetch(message, browserUseState());
          return;
        }
        case "browser-use-approval-mode-write": {
          successFetch(message, updateBrowserUseApprovalMode(params));
          return;
        }
        case "browser-use-history-approval-mode-write": {
          successFetch(message, updateBrowserUseHistoryApprovalMode(params));
          return;
        }
        case "browser-use-file-transfer-approval-mode-write": {
          successFetch(message, updateBrowserUseFileTransferApprovalMode(params));
          return;
        }
        case "browser-use-origin-add": {
          successFetch(message, updateBrowserUseOrigin(params, true));
          return;
        }
        case "browser-use-origin-remove": {
          successFetch(message, updateBrowserUseOrigin(params, false));
          return;
        }
        case "browser-use-file-transfer-origin-add": {
          successFetch(message, updateBrowserUseOrigin(params, true));
          return;
        }
        case "browser-use-file-transfer-origin-remove": {
          successFetch(message, updateBrowserUseOrigin(params, false));
          return;
        }
        case "browser-browsing-data-clear": {
          successFetch(message, { ok: true });
          return;
        }
        case "chrome-native-host-install":
        case "chrome-native-host-uninstall":
        case "chrome-extension-settings-open": {
          successFetch(message, { ok: true });
          return;
        }
        case "computer-use-app-approvals-visibility": {
          successFetch(message, { visible: true });
          return;
        }
        case "computer-use-app-approvals-read": {
          successFetch(message, { approvedApps: [] });
          return;
        }
        case "computer-use-app-approval-remove": {
          successFetch(message, { approvedApps: [] });
          return;
        }
        case "computer-use-sound-mode-read": {
          successFetch(message, { value: webState.globalState["computer-use-sound-mode"] ?? "foregroundClicks" });
          return;
        }
        case "computer-use-sound-mode-write": {
          webState.globalState["computer-use-sound-mode"] = params.value ?? "foregroundClicks";
          queuePersist();
          successFetch(message, { value: webState.globalState["computer-use-sound-mode"] });
          return;
        }
        case "computer-use-background-auth-read": {
          successFetch(message, {
            enabled: Boolean(webState.globalState["computer-use-background-auth-enabled"]),
            computerIconDataURL: null,
            lockIconDataURL: null,
          });
          return;
        }
        case "computer-use-background-auth-write": {
          webState.globalState["computer-use-background-auth-enabled"] = Boolean(params.enabled);
          queuePersist();
          successFetch(message, {
            enabled: Boolean(params.enabled),
            computerIconDataURL: null,
            lockIconDataURL: null,
          });
          return;
        }
        case "list-automations": {
          successFetch(message, webModeHostRpcFallback(method));
          return;
        }
        case "get-is-conversation-archiving-for-host": {
          successFetch(message, webModeHostRpcFallback(method));
          return;
        }
        case "hotkey-window-hotkey-state": {
          successFetch(message, webModeHostRpcFallback(method));
          return;
        }
        case "paths-exist": {
          successFetch(message, await existingHostPaths(params));
          return;
        }
        default: {
          const appServerMethod = hostFetchAppServerRpcMethods.get(method);
          if (appServerMethod) {
            successFetch(message, await requestAppServerRpc(appServerMethod, params));
            return;
          }
          successFetch(message, {});
        }
      }
    } catch (error) {
      errorFetch(message, error);
    }
  }

  async function handleMcpRequest(message) {
    await ready;
    const rpc = message.request;
    if (!rpc?.method || rpc.id == null) {
      return;
    }
    const fallback = webModeHostRpcFallback(rpc.method);
    if (fallback !== noHostRpcFallback) {
      emit({
        type: "mcp-response",
        hostId: message.hostId || localHostId,
        message: {
          id: rpc.id,
          result: fallback,
        },
      });
      return;
    }
    try {
      const response = await request("appServer.rpc", {
        method: rpc.method,
        params: rpc.params ?? {},
      });
      emit({
        type: "mcp-response",
        hostId: message.hostId || localHostId,
        message: {
          id: rpc.id,
          result: response.result,
        },
      });
    } catch (error) {
      emit({
        type: "mcp-response",
        hostId: message.hostId || localHostId,
        message: {
          id: rpc.id,
          error: {
            code: -32000,
            message: error instanceof Error ? error.message : String(error),
          },
        },
      });
    }
  }

  function dictationTarget() {
    const active = document?.activeElement;
    if (isEditableElement(active)) {
      return active;
    }
    for (const selector of ['[contenteditable="true"]', "textarea", '[role="textbox"]']) {
      const element = document?.querySelector?.(selector);
      if (isEditableElement(element)) {
        return element;
      }
    }
    return null;
  }

  function isEditableElement(element) {
    if (!element || typeof element !== "object") {
      return false;
    }
    return Boolean(element.isContentEditable) || typeof element.value === "string" || element.getAttribute?.("role") === "textbox";
  }

  function insertDictationText(text) {
    if (typeof text !== "string" || text.length === 0) {
      return;
    }
    const target = dictationTarget();
    if (!target) {
      window.alert?.("Dictation is available, but no composer is focused.");
      return;
    }
    target.focus?.();
    if (typeof target.value === "string") {
      const start = Number.isInteger(target.selectionStart) ? target.selectionStart : target.value.length;
      const end = Number.isInteger(target.selectionEnd) ? target.selectionEnd : start;
      target.value = `${target.value.slice(0, start)}${text}${target.value.slice(end)}`;
      const cursor = start + text.length;
      target.setSelectionRange?.(cursor, cursor);
      target.dispatchEvent?.(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      return;
    }
    if (document?.execCommand?.("insertText", false, text)) {
      target.dispatchEvent?.(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      return;
    }
    target.textContent = `${target.textContent ?? ""}${text}`;
    target.dispatchEvent?.(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  }

  function startDictation() {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) {
      window.alert?.("Browser dictation is not available in this browser.");
      return { ok: false, reason: "speech-recognition-unavailable" };
    }
    if (dictationRecognition) {
      dictationRecognition.stop?.();
      dictationRecognition = null;
      return { ok: true, stopped: true };
    }
    try {
      const recognition = new Recognition();
      dictationRecognition = recognition;
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.lang = navigator.language || "en-US";
      recognition.onresult = (event) => {
        let finalText = "";
        for (let index = event.resultIndex ?? 0; index < event.results.length; index += 1) {
          const result = event.results[index];
          if (result?.isFinal) {
            finalText += result[0]?.transcript ?? "";
          }
        }
        insertDictationText(finalText);
      };
      recognition.onerror = (event) => {
        const message = event?.error ? `Dictation failed: ${event.error}` : "Dictation failed.";
        window.alert?.(message);
      };
      recognition.onend = () => {
        if (dictationRecognition === recognition) {
          dictationRecognition = null;
        }
      };
      recognition.start();
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      window.alert?.(`Unable to start dictation: ${message}`);
      dictationRecognition = null;
      return { ok: false, reason: message };
    }
  }

  function stopDictation() {
    if (!dictationRecognition) {
      return { ok: true, stopped: false };
    }
    dictationRecognition.stop?.();
    dictationRecognition = null;
    return { ok: true, stopped: true };
  }

  async function handleMessageFromView(message) {
    if (!message || typeof message.type !== "string") {
      return;
    }

    switch (message.type) {
      case "ready":
        return;
      case "log-message":
        return;
      case "persisted-atom-sync-request": {
        await ready;
        emit({ type: "persisted-atom-sync", state: webState.persistedAtoms ?? {} });
        return;
      }
      case "persisted-atom-update": {
        await ready;
        if (message.deleted) {
          delete webState.persistedAtoms[message.key];
        } else {
          webState.persistedAtoms[message.key] = message.value;
        }
        queuePersist();
        emit({
          type: "persisted-atom-updated",
          key: message.key,
          value: message.value,
          deleted: Boolean(message.deleted),
        });
        return;
      }
      case "shared-object-subscribe": {
        await ready;
        emit({
          type: "shared-object-updated",
          key: message.key,
          value: webState.sharedObjects?.[message.key] ?? null,
        });
        return;
      }
      case "shared-object-set": {
        await ready;
        webState.sharedObjects[message.key] = message.value;
        queuePersist();
        emit({
          type: "shared-object-updated",
          key: message.key,
          value: message.value,
        });
        return;
      }
      case "electron-add-new-workspace-root-option": {
        await ready;
        const root = typeof message.root === "string" && message.root.trim().length > 0
          ? message.root.trim()
          : await promptForWorkspaceRoot();
        if (!root) {
          return { ok: false, reason: "cancelled" };
        }
        try {
          return { ok: true, ...(await addWorkspaceRoot(root, { setActive: true })) };
        } catch (error) {
          return reportWorkspaceRootError(error);
        }
      }
      case "electron-create-new-workspace-root-option": {
        await ready;
        try {
          const response = await request("workspace.createProject", {
            projectName: message.projectName,
          });
          const root = response.result?.path;
          return { ok: true, ...(await addWorkspaceRoot(root, { setActive: true })) };
        } catch (error) {
          return reportWorkspaceRootError(error);
        }
      }
      case "electron-set-active-workspace-root": {
        await ready;
        try {
          return { ok: true, ...(await addWorkspaceRoot(message.root, { setActive: true })) };
        } catch (error) {
          return reportWorkspaceRootError(error);
        }
      }
      case "electron-clear-active-workspace-root": {
        await ready;
        webState.globalState["active-workspace-roots"] = { roots: [] };
        emitWorkspaceStateUpdated(["active-workspace-roots"]);
        return { ok: true, activeWorkspaceRoots: webState.globalState["active-workspace-roots"] };
      }
      case "electron-update-workspace-root-options": {
        await ready;
        const roots = coerceWorkspaceRoots(message);
        const activeRoots = coerceWorkspaceRoots(webState.globalState["active-workspace-roots"]).filter((root) =>
          roots.includes(root),
        );
        return { ok: true, ...setWorkspaceRootState(roots, activeRoots) };
      }
      case "mcp-response":
        await writeAppServerMessage(message.message ?? message.response ?? message);
        return;
      case "fetch":
        await handleFetch(message);
        return;
      case "send-cli-request-for-host":
        return await requestDesktopIpc(message.method, message.params ?? {}, message.timeoutMs);
      case "start-conversation":
        return await startConversation(message.params ?? message);
      case "thread-follower-start-turn":
        return await startFollowerTurn(message.params ?? message);
      case "global-dictation-start":
      case "global-dictation-in-app-start":
        return startDictation();
      case "global-dictation-stop":
      case "global-dictation-in-app-stop":
        return stopDictation();
      case "open-in-browser":
        if (typeof message.url === "string" && message.url.trim().length > 0) {
          window.open(message.url, "_blank", "noopener,noreferrer");
        }
        return;
      case "browser-sidebar-command":
        return;
      case "browser-use-turn-route-release":
      case "computer-use-turn-route-release":
        await ready;
        return await recoverConversationTurn(message.conversationId, message.turnId);
      case "interrupt-conversation":
      case "thread-follower-interrupt-turn-for-host":
        return await interruptConversation(message.conversationId, message.conversationState);
      case "cancel-fetch":
      case "cancel-fetch-stream":
        return;
      case "mcp-request":
      case "thread-prewarm-start":
        await handleMcpRequest(message);
        return;
      default:
        request("host.postMessage", message).catch(() => {});
    }
  }

  function getSessionId() {
    let sessionId = window.sessionStorage.getItem(sessionKey);
    if (!sessionId) {
      sessionId = crypto.randomUUID();
      window.sessionStorage.setItem(sessionKey, sessionId);
    }
    return sessionId;
  }

  function scheduleEventStreamReconnect() {
    window.clearTimeout(eventStreamReconnectTimer);
    eventStreamReconnectTimer = window.setTimeout(() => {
      subscribeToAppServerEvents();
      recoverTrackedActiveTurns();
    }, eventStreamReconnectDelayMs);
    eventStreamReconnectDelayMs = Math.min(eventStreamReconnectDelayMs * 2, eventStreamReconnectMaxDelayMs);
  }

  function subscribeToAppServerEvents() {
    try {
      eventStream?.close?.();
      const events = new EventSource(
        `${window.location.origin}/__codex/app-server/events?codex_web_token=${encodeURIComponent(bridgeToken)}`,
      );
      eventStream = events;
      events.onopen = () => {
        eventStreamReconnectDelayMs = 250;
      };
      events.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message.method) {
            emitAppServerNotification(message.method, message.params ?? {});
          }
        } catch (error) {
          console.warn("[codex-web] invalid app-server event", error);
        }
      };
      events.onerror = () => {
        if (eventStream === events) {
          eventStream = null;
        }
        events.close?.();
        scheduleEventStreamReconnect();
      };
    } catch (error) {
      console.warn("[codex-web] failed to subscribe to app-server events", error);
      scheduleEventStreamReconnect();
    }
  }

  const vscodeApi = {
    postMessage(message) {
      handleMessageFromView(message).catch((error) => {
        console.warn("[codex-web] host message failed", error);
      });
      return true;
    },
    getState() {
      try {
        return JSON.parse(window.sessionStorage.getItem(vscodeStateKey) || "null");
      } catch {
        return null;
      }
    },
    setState(state) {
      window.sessionStorage.setItem(vscodeStateKey, JSON.stringify(state));
      return state;
    },
  };

  window.electronBridge = {
    async sendMessageFromView(message) {
      return await handleMessageFromView(message);
    },
    getSentryInitOptions() {
      return null;
    },
    getAppSessionId: getSessionId,
    getBuildFlavor() {
      return "prod";
    },
    getSystemThemeVariant() {
      return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    },
    subscribeToSystemThemeVariant(callback) {
      const media = window.matchMedia?.("(prefers-color-scheme: dark)");
      if (!media) {
        return () => {};
      }
      const listener = () => callback();
      media.addEventListener?.("change", listener);
      return () => media.removeEventListener?.("change", listener);
    },
    getSharedObjectSnapshotValue(key) {
      refreshWorkspaceObjects();
      return structuredCloneSafe(webState.sharedObjects?.[key] ?? null);
    },
    getPathForFile(file) {
      return file?.path ?? null;
    },
    async triggerSentryTestError() {
      throw new Error("Codex web-mode Sentry test error");
    },
    async showApplicationMenu() {},
    async showContextMenu() {
      return undefined;
    },
    subscribeToWorkerMessages() {
      return () => {};
    },
    async sendWorkerMessageFromView() {
      return { ok: false, reason: "electron-worker-bridge-unavailable-in-web-mode" };
    },
  };

  window.codexDesktopWeb = {
    mode: "devcontainer-web",
    request,
    postHostMessage: vscodeApi.postMessage,
    getState: vscodeApi.getState,
    setState: vscodeApi.setState,
  };

  window.acquireVsCodeApi = window.acquireVsCodeApi || (() => vscodeApi);
  window.addEventListener("codex-message-from-view", (event) => {
    if (event.__codexForwardedViaBridge) {
      return;
    }
    handleMessageFromView(event.detail).catch((error) => {
      console.warn("[codex-web] DOM host message failed", error);
    });
  });

  subscribeToAppServerEvents();
})();
