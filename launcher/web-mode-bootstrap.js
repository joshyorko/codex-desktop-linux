(function () {
  const bridgeUrl = `${window.location.origin}/__codex/bridge`;
  const bridgeToken = window.__CODEX_WEB_TOKEN__ || "";
  const localHostId = "local";
  const sessionKey = "codex-desktop-web-session-id";
  const vscodeStateKey = "codex-desktop-web-vscode-state";
  const cssPreloadErrorPrefix = "Unable to preload CSS for ";

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

  installCssPreloadErrorGuard();

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
    const workspace = health?.workspace || "/workspace";
    const profile = health?.profile || `${workspace}/.codex-desktop`;
    webState.sharedObjects.host_config = {
      id: localHostId,
      display_name: "Local",
      kind: "local",
    };
    webState.globalState["active-workspace-roots"] ??= { roots: [workspace] };
    webState.globalState["electron-saved-workspace-roots"] ??= { roots: [workspace] };
    webState.globalState["workspace-root-options"] ??= { roots: [workspace] };
    webState.globalState["codex-home"] ??= `${profile}/profile/codex-home`;
    webState.globalState["home-directory"] ??= workspace;
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

  async function handleFetch(message) {
    await ready;
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
        case "workspace-root-options": {
          const workspace = health?.workspace || "/workspace";
          successFetch(message, webState.globalState[method] ?? { roots: [workspace] });
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
            extensionKind: "web",
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
        case "paths-exist": {
          successFetch(message, { existingPaths: [] });
          return;
        }
        default: {
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
      case "fetch":
        await handleFetch(message);
        return;
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

	  function subscribeToAppServerEvents() {
    try {
      const events = new EventSource(
        `${window.location.origin}/__codex/app-server/events?codex_web_token=${encodeURIComponent(bridgeToken)}`,
      );
      events.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message.id != null && message.method) {
            emit({ type: "mcp-request", hostId: localHostId, request: message });
          }
        } catch (error) {
          console.warn("[codex-web] invalid app-server event", error);
        }
      };
    } catch (error) {
      console.warn("[codex-web] failed to subscribe to app-server events", error);
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
      await handleMessageFromView(message);
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
      throw new Error("Electron worker bridge is unavailable in devcontainer web mode");
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
