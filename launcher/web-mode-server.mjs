#!/usr/bin/env node

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEXT_MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function usage() {
  console.error(`Usage:
  codex-desktop serve --workspace <dir> --profile <dir> [--bind 127.0.0.1] [--port 3773]
  codex-desktop web --inspect
  codex-desktop doctor --mode devcontainer`);
}

function parseArgs(argv) {
  const args = {
    command: "serve",
    appDir: path.resolve(__dirname, ".."),
    bind: "127.0.0.1",
    port: 3773,
    workspace: process.cwd(),
    profile: null,
    requireToken: false,
    onceHealthCheck: false,
    mode: null,
  };

  if (argv[0] && !argv[0].startsWith("-")) {
    args.command = argv.shift();
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--app-dir") {
      args.appDir = path.resolve(argv[++index] ?? "");
    } else if (arg === "--workspace") {
      args.workspace = path.resolve(argv[++index] ?? "");
    } else if (arg === "--profile") {
      args.profile = path.resolve(argv[++index] ?? "");
    } else if (arg === "--bind") {
      args.bind = argv[++index] ?? "";
    } else if (arg === "--port") {
      args.port = Number.parseInt(argv[++index] ?? "", 10);
    } else if (arg === "--require-token") {
      args.requireToken = true;
    } else if (arg === "--once-health-check") {
      args.onceHealthCheck = true;
    } else if (arg === "--mode") {
      args.mode = argv[++index] ?? null;
    } else if (arg === "--inspect") {
      args.command = "inspect";
    } else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535) {
    throw new Error("--port must be between 0 and 65535");
  }

  args.profile = args.profile ?? path.join(args.workspace, ".codex-desktop");
  args.webviewDir = path.join(args.appDir, "content", "webview");
  args.bootstrapPath = path.join(args.appDir, ".codex-linux", "web-mode-bootstrap.js");
  args.webHostDir = path.join(args.profile, "run");
  args.logsDir = path.join(args.profile, "logs");
  args.browserProfileDir = path.join(args.profile, "browser");
  args.codexProfileDir = path.join(args.profile, "profile");
  args.runDir = path.join(args.profile, "run");
  args.webStatePath = path.join(args.codexProfileDir, "web-state.json");

  return args;
}

function isLoopback(bind) {
  return bind === "127.0.0.1" || bind === "localhost" || bind === "::1";
}

function jsonResponse(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store, max-age=0",
  });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

function textResponse(response, status, body) {
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store, max-age=0",
  });
  response.end(body);
}

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function ensureProfileDirs(args) {
  for (const directory of [
    args.profile,
    args.codexProfileDir,
    args.browserProfileDir,
    args.runDir,
    args.logsDir,
    path.join(args.codexProfileDir, "codex-home"),
    path.join(args.codexProfileDir, "xdg-config"),
    path.join(args.codexProfileDir, "xdg-cache"),
    path.join(args.codexProfileDir, "xdg-state"),
    path.join(args.runDir, "browser-use"),
  ]) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  }
}

function createState(args) {
  const token = crypto.randomBytes(24).toString("base64url");
  return {
    args,
    token,
    startedAt: new Date().toISOString(),
    nextRpcId: 1,
    pendingRpc: new Map(),
    notifications: [],
    sseClients: new Set(),
    appServer: {
      status: "not_started",
      pid: null,
      transport: "stdio",
      initialized: false,
      initialize_result: null,
      last_error: null,
    },
    browser: {
      mode: "disabled",
      reason: "container Chromium/CDP sidecar not started yet",
      profile_dir: args.browserProfileDir,
      cdp_endpoint: null,
    },
    computer: {
      mode: "browser-only",
      desktop_control: "disabled_by_mode",
      physical_host_control: false,
      blocked_host_env: [
        "DISPLAY",
        "WAYLAND_DISPLAY",
        "XAUTHORITY",
        "DBUS_SESSION_BUS_ADDRESS",
        "XDG_SESSION_ID",
        "DESKTOP_SESSION",
        "XDG_CURRENT_DESKTOP",
        "GNOME_DESKTOP_SESSION_ID",
        "KDE_FULL_SESSION",
        "SWAYSOCK",
        "HYPRLAND_INSTANCE_SIGNATURE",
        "I3SOCK",
        "YDOTOOL_SOCKET",
      ],
    },
  };
}

function appendAppServerLog(state, chunk) {
  const line = chunk.toString("utf8");
  fs.appendFile(path.join(state.args.logsDir, "app-server.log"), line).catch(() => {});
}

function publishAppServerNotification(state, message) {
  state.notifications.push({
    at: new Date().toISOString(),
    message,
  });
  if (state.notifications.length > 200) {
    state.notifications.splice(0, state.notifications.length - 200);
  }

  const payload = `data: ${JSON.stringify(message)}\n\n`;
  for (const client of state.sseClients) {
    client.write(payload);
  }
}

function handleAppServerMessage(state, line) {
  if (line.trim() === "") {
    return;
  }

  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    state.appServer.last_error = `invalid app-server JSON: ${error.message}`;
    appendAppServerLog(state, `invalid stdout line: ${line}\n`);
    return;
  }

  if (Object.hasOwn(message, "id") && state.pendingRpc.has(message.id)) {
    const pending = state.pendingRpc.get(message.id);
    state.pendingRpc.delete(message.id);
    if (message.error) {
      pending.reject(Object.assign(new Error(message.error.message || "app-server request failed"), { response: message }));
    } else {
      pending.resolve(message.result);
    }
    return;
  }

  publishAppServerNotification(state, message);
}

function appServerEnv(args) {
  const codexHome = path.join(args.codexProfileDir, "codex-home");
  const xdgConfigHome = path.join(args.codexProfileDir, "xdg-config");
  const xdgCacheHome = path.join(args.codexProfileDir, "xdg-cache");
  const xdgStateHome = path.join(args.codexProfileDir, "xdg-state");

  const env = {
    ...process.env,
    CODEX_HOME: codexHome,
    XDG_CONFIG_HOME: xdgConfigHome,
    XDG_CACHE_HOME: xdgCacheHome,
    XDG_STATE_HOME: xdgStateHome,
    CODEX_DESKTOP_WEB_MODE: "1",
    CODEX_DESKTOP_DEVCONTAINER_MODE: "1",
    CODEX_BROWSER_MODE: process.env.CODEX_BROWSER_MODE || "container-chromium",
    CODEX_BROWSER_PROFILE_DIR: args.browserProfileDir,
    CODEX_BROWSER_USE_SOCKET_DIR: path.join(args.runDir, "browser-use"),
    CODEX_COMPUTER_USE_BROWSER_ONLY: "1",
    CODEX_COMPUTER_CONTROL_MODE: "browser-only",
  };

  for (const key of [
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XAUTHORITY",
    "DBUS_SESSION_BUS_ADDRESS",
    "XDG_SESSION_ID",
    "DESKTOP_SESSION",
    "XDG_CURRENT_DESKTOP",
    "GNOME_DESKTOP_SESSION_ID",
    "KDE_FULL_SESSION",
    "SWAYSOCK",
    "HYPRLAND_INSTANCE_SIGNATURE",
    "I3SOCK",
    "YDOTOOL_SOCKET",
  ]) {
    delete env[key];
  }

  return env;
}

function appServerCommand() {
  return process.env.CODEX_CLI_PATH || "codex";
}

// Browser clients talk to this loopback host bridge; the bridge talks to
// `codex app-server --listen stdio://` so the raw app-server port is never
// exposed outside the devcontainer.
function browserCandidates() {
  if (process.env.CODEX_BROWSER_USE_BROWSER_COMMAND) {
    return [process.env.CODEX_BROWSER_USE_BROWSER_COMMAND];
  }
  return ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "brave-browser", "brave"];
}

async function findExecutable(commandName) {
  if (commandName.includes("/")) {
    return (await exists(commandName)) ? commandName : null;
  }

  for (const directory of (process.env.PATH || "").split(":")) {
    if (!directory) {
      continue;
    }
    const candidate = path.join(directory, commandName);
    try {
      await fs.access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

async function startBrowserSidecar(state) {
  const explicitEndpoint = process.env.CODEX_BROWSER_CDP_ENDPOINT;
  if (explicitEndpoint) {
    state.browser = {
      mode: "playwright-cdp",
      reason: "using explicit CODEX_BROWSER_CDP_ENDPOINT",
      profile_dir: state.args.browserProfileDir,
      cdp_endpoint: explicitEndpoint,
      pid: null,
    };
    return;
  }

  let browserCommand = null;
  for (const candidate of browserCandidates()) {
    browserCommand = await findExecutable(candidate);
    if (browserCommand) {
      break;
    }
  }

  if (!browserCommand) {
    state.browser = {
      mode: "disabled",
      reason: "no container Chromium/Chrome/Brave command found",
      profile_dir: state.args.browserProfileDir,
      cdp_endpoint: null,
      pid: null,
    };
    return;
  }

  const cdpPort = Number.parseInt(process.env.CODEX_BROWSER_CDP_PORT || "9333", 10);
  const userDataDir = path.join(state.args.browserProfileDir, "chromium");
  await fs.mkdir(userDataDir, { recursive: true, mode: 0o700 });

  const args = [
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    "about:blank",
  ];

  const child = spawn(browserCommand, args, {
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      CODEX_DESKTOP_WEB_MODE: "1",
      CODEX_DESKTOP_DEVCONTAINER_MODE: "1",
    },
  });

  child.stderr.on("data", (chunk) => {
    fs.appendFile(path.join(state.args.logsDir, "browser-use.log"), chunk).catch(() => {});
  });
  child.on("exit", (code, signal) => {
    state.browser.reason = `browser exited code=${code} signal=${signal}`;
    state.browser.pid = null;
  });

  state.browser = {
    mode: "container-chromium",
    reason: "waiting for container-local Chromium/CDP sidecar",
    command: browserCommand,
    profile_dir: state.args.browserProfileDir,
    cdp_endpoint: `http://127.0.0.1:${cdpPort}`,
    socket_dir: path.join(state.args.runDir, "browser-use"),
    pid: child.pid ?? null,
  };
  state.browser.child = child;
  process.env.CODEX_BROWSER_MODE = "container-chromium";
  process.env.CODEX_BROWSER_PROFILE_DIR = state.args.browserProfileDir;
  process.env.CODEX_BROWSER_CDP_ENDPOINT = state.browser.cdp_endpoint;
  process.env.CODEX_BROWSER_USE_SOCKET_DIR = state.browser.socket_dir;

  try {
    await waitForCdpEndpoint(state.browser.cdp_endpoint, 5000);
    state.browser.reason = "container-local Chromium/CDP sidecar ready";
    state.browser.cdp_ready = true;
  } catch (error) {
    state.browser.mode = "disabled";
    state.browser.reason = `container Chromium/CDP sidecar failed readiness: ${error.message}`;
    state.browser.cdp_ready = false;
  }
}

async function waitForCdpEndpoint(endpoint, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(500) });
      if (response.ok) {
        return;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError ?? new Error("timed out");
}

function stopBrowserSidecar(state) {
  if (state.browser.child && !state.browser.child.killed) {
    state.browser.child.kill("SIGTERM");
  }
}

async function sendAppServerRpc(state, method, params = {}, timeoutMs = 30000) {
  if (!state.appServer.child || !state.appServer.child.stdin.writable) {
    throw new Error("app-server is not running");
  }

  const id = state.nextRpcId++;
  const message = { id, method, params };
  const response = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      state.pendingRpc.delete(id);
      reject(new Error(`app-server request timed out: ${method}`));
    }, timeoutMs);
    state.pendingRpc.set(id, {
      resolve(value) {
        clearTimeout(timeout);
        resolve(value);
      },
      reject(error) {
        clearTimeout(timeout);
        reject(error);
      },
    });
  });

  state.appServer.child.stdin.write(`${JSON.stringify(message)}\n`);
  return response;
}

function startAppServer(state) {
  if (state.appServer.child) {
    return;
  }

  const child = spawn(appServerCommand(), ["app-server", "--listen", "stdio://"], {
    cwd: state.args.workspace,
    env: appServerEnv(state.args),
    stdio: ["pipe", "pipe", "pipe"],
  });

  state.appServer.child = child;
  state.appServer.status = "starting";
  state.appServer.pid = child.pid ?? null;

  let stdoutBuffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    let newlineIndex;
    while ((newlineIndex = stdoutBuffer.indexOf("\n")) !== -1) {
      const line = stdoutBuffer.slice(0, newlineIndex);
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      handleAppServerMessage(state, line);
    }
  });
  child.stderr.on("data", (chunk) => appendAppServerLog(state, chunk));
  child.on("error", (error) => {
    state.appServer.status = "error";
    state.appServer.last_error = error.message;
  });
  child.on("exit", (code, signal) => {
    state.appServer.status = "exited";
    state.appServer.pid = null;
    state.appServer.last_error = `exited code=${code} signal=${signal}`;
  });

  sendAppServerRpc(
    state,
    "initialize",
    {
      clientInfo: {
        name: "codex-desktop-linux-web",
        title: "Codex Desktop Linux Web",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    },
    10000,
  )
    .then((result) => {
      state.appServer.status = "running";
      state.appServer.initialized = true;
      state.appServer.initialize_result = result;
      if (state.appServer.child?.stdin?.writable) {
        state.appServer.child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
      }
    })
    .catch((error) => {
      state.appServer.status = "error";
      state.appServer.last_error = error.message;
    });
}

function stopAppServer(state) {
  if (state.appServer.child && !state.appServer.child.killed) {
    state.appServer.child.kill("SIGTERM");
  }
}

function browserStatus(state) {
  const { child, ...status } = state.browser;
  return status;
}

function appServerStatus(state) {
  return {
    status: state.appServer.status,
    pid: state.appServer.pid,
    transport: state.appServer.transport,
    initialized: state.appServer.initialized,
    initialize_result: state.appServer.initialize_result,
    last_error: state.appServer.last_error,
  };
}

function health(state, serverAddress = null) {
  const { args } = state;
  return {
    package: "codex-desktop-linux",
    mode: "devcontainer-web",
    loopback_only_default: true,
    bind: args.bind,
    port: serverAddress?.port ?? args.port,
    url: serverAddress ? `http://${args.bind}:${serverAddress.port}/` : null,
    workspace: args.workspace,
    profile: args.profile,
    webview_dir: args.webviewDir,
    webview_dir_exists: null,
    started_at: state.startedAt,
    auth: {
      required: true,
      token_present: Boolean(state.token),
    },
    app_server: appServerStatus(state),
    browser_use: browserStatus(state),
    computer_use: state.computer,
  };
}

async function resolveStaticPath(root, requestPath) {
  const decodedPath = decodeURIComponent(requestPath.split("?")[0]);
  const cleanPath = decodedPath === "/" ? "/index.html" : decodedPath;
  const target = path.resolve(root, `.${cleanPath}`);
  const rootWithSeparator = `${path.resolve(root)}${path.sep}`;
  if (target !== path.resolve(root) && !target.startsWith(rootWithSeparator)) {
    return null;
  }
  return target;
}

async function serveIndex(response, state, indexPath) {
  let source = await fs.readFile(indexPath, "utf8");
  const scriptTag = '<script src="/__codex/web-mode-bootstrap.js"></script>';
  if (!source.includes(scriptTag)) {
    if (source.includes("</head>")) {
      source = source.replace("</head>", `${scriptTag}\n</head>`);
    } else {
      source = `${scriptTag}\n${source}`;
    }
  }
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store, max-age=0",
    "x-codex-desktop-web-mode": "1",
  });
  response.end(source);
}

function patchWebModeAssetSource(target, source) {
  if (path.basename(target).startsWith("electron-menu-shortcuts-")) {
    return source.replaceAll("t?.bindings.filter", "t?.bindings?.filter");
  }
  return source;
}

function sameOriginAllowed(request, state) {
  const origin = request.headers.origin;
  if (!origin) {
    return true;
  }
  const host = request.headers.host;
  return origin === `http://${host}` || origin === `http://${state.args.bind}:${state.args.port}`;
}

function hasBridgeToken(request, state, url) {
  const headerToken = request.headers["x-codex-web-token"];
  const queryToken = url.searchParams.get("codex_web_token");
  return headerToken === state.token || queryToken === state.token;
}

function authorizeBridgeRequest(request, response, state, url) {
  if (!sameOriginAllowed(request, state)) {
    jsonResponse(response, 403, { error: "forbidden_origin" });
    return false;
  }
  if (!hasBridgeToken(request, state, url)) {
    jsonResponse(response, 401, { error: "missing_or_invalid_token" });
    return false;
  }
  return true;
}

async function readJsonRequest(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return null;
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function readWebState(args) {
  try {
    const source = await fs.readFile(args.webStatePath, "utf8");
    const parsed = JSON.parse(source);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function writeWebState(args, state) {
  await fs.mkdir(path.dirname(args.webStatePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(args.webStatePath, `${JSON.stringify(state ?? {}, null, 2)}\n`, { mode: 0o600 });
}

function createServer(state) {
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/__codex/health") {
        const body = health(state, response.socket.server.address());
        body.webview_dir_exists = await exists(state.args.webviewDir);
        jsonResponse(response, 200, body);
        return;
      }

      if (url.pathname === "/__codex/doctor") {
        const body = health(state, response.socket.server.address());
        body.webview_dir_exists = await exists(state.args.webviewDir);
        body.doctor = {
          status: body.webview_dir_exists ? "ok" : "degraded",
          warnings: body.webview_dir_exists ? [] : [`Missing webview directory: ${state.args.webviewDir}`],
        };
        jsonResponse(response, 200, body);
        return;
      }

      if (url.pathname === "/__codex/web-mode-bootstrap.js") {
        const source = `window.__CODEX_WEB_TOKEN__ = ${JSON.stringify(state.token)};\n${await fs.readFile(state.args.bootstrapPath, "utf8")}`;
        response.writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "no-store, max-age=0",
        });
        response.end(source);
        return;
      }

      if (url.pathname === "/__codex/bridge") {
        if (!authorizeBridgeRequest(request, response, state, url)) {
          return;
        }
        if (request.method !== "POST") {
          jsonResponse(response, 405, { error: "method_not_allowed" });
          return;
        }
        const message = await readJsonRequest(request);
        if (message?.method === "appServer.rpc") {
          const result = await sendAppServerRpc(state, message.params?.method, message.params?.params ?? {});
          jsonResponse(response, 200, { ok: true, result });
          return;
        }
        if (message?.method === "webState.read") {
          jsonResponse(response, 200, { ok: true, result: await readWebState(state.args) });
          return;
        }
        if (message?.method === "webState.write") {
          await writeWebState(state.args, message.params?.state ?? {});
          jsonResponse(response, 200, { ok: true });
          return;
        }
        if (message?.method === "health.read") {
          const body = health(state, response.socket.server.address());
          body.webview_dir_exists = await exists(state.args.webviewDir);
          jsonResponse(response, 200, { ok: true, result: body });
          return;
        }
        jsonResponse(response, 200, {
          ok: true,
          received: message,
          app_server: appServerStatus(state),
        });
        return;
      }

      if (url.pathname === "/__codex/app-server/status") {
        if (!authorizeBridgeRequest(request, response, state, url)) {
          return;
        }
        jsonResponse(response, 200, appServerStatus(state));
        return;
      }

      if (url.pathname === "/__codex/app-server/auth") {
        if (!authorizeBridgeRequest(request, response, state, url)) {
          return;
        }
        const result = await sendAppServerRpc(state, "account/read", { refreshToken: false });
        jsonResponse(response, 200, result);
        return;
      }

      if (url.pathname === "/__codex/app-server/rpc") {
        if (!authorizeBridgeRequest(request, response, state, url)) {
          return;
        }
        if (request.method !== "POST") {
          jsonResponse(response, 405, { error: "method_not_allowed" });
          return;
        }
        const message = await readJsonRequest(request);
        const method = message?.method;
        if (!method || typeof method !== "string") {
          jsonResponse(response, 400, { error: "missing_method" });
          return;
        }
        const result = await sendAppServerRpc(state, method, message.params ?? {});
        jsonResponse(response, 200, { id: message.id ?? null, result });
        return;
      }

      if (url.pathname === "/__codex/app-server/events") {
        if (!authorizeBridgeRequest(request, response, state, url)) {
          return;
        }
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store, max-age=0",
          connection: "keep-alive",
        });
        response.write(": connected\n\n");
        state.sseClients.add(response);
        request.on("close", () => {
          state.sseClients.delete(response);
        });
        return;
      }

      if (url.pathname === "/__codex/browser/status") {
        if (!authorizeBridgeRequest(request, response, state, url)) {
          return;
        }
        jsonResponse(response, 200, browserStatus(state));
        return;
      }

      const target = await resolveStaticPath(state.args.webviewDir, url.pathname);
      if (!target) {
        textResponse(response, 403, "Forbidden\n");
        return;
      }

      const stat = await fs.stat(target);
      if (!stat.isFile()) {
        textResponse(response, 404, "Not found\n");
        return;
      }

      if (path.basename(target) === "index.html") {
        await serveIndex(response, state, target);
        return;
      }

      response.writeHead(200, {
        "content-type": TEXT_MIME_TYPES.get(path.extname(target).toLowerCase()) ?? "application/octet-stream",
        "cache-control": "no-store, max-age=0",
      });
      if (path.extname(target).toLowerCase() === ".js") {
        response.end(patchWebModeAssetSource(target, await fs.readFile(target, "utf8")));
        return;
      }
      response.end(await fs.readFile(target));
    } catch (error) {
      jsonResponse(response, 500, { error: error.message });
    }
  });
}

async function serve(args) {
  if (!isLoopback(args.bind) && !args.requireToken) {
    throw new Error("non-loopback bind requires --require-token");
  }

  await ensureProfileDirs(args);
  const state = createState(args);
  await startBrowserSidecar(state);
  startAppServer(state);
  const server = createServer(state);

  process.once("SIGINT", () => {
    stopBrowserSidecar(state);
    stopAppServer(state);
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    stopBrowserSidecar(state);
    stopAppServer(state);
    process.exit(143);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(args.port, args.bind, resolve);
  });

  const address = server.address();
  const url = `http://${args.bind}:${address.port}/`;
  console.error(`[codex-web] serving ${url}`);
  console.error(`[codex-web] workspace=${args.workspace}`);
  console.error(`[codex-web] profile=${args.profile}`);

  if (args.onceHealthCheck) {
    const body = await new Promise((resolve, reject) => {
      const req = http.get(`${url}__codex/health`, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      });
      req.on("error", reject);
    });
    JSON.parse(body);
    process.stdout.write(body);
    await new Promise((resolve) => server.close(resolve));
    stopBrowserSidecar(state);
    stopAppServer(state);
    return;
  }

  console.log(url);
}

async function inspect(args) {
  const body = health(createState(args));
  body.webview_dir_exists = await exists(args.webviewDir);
  jsonResponse(
    {
      writeHead() {},
      end(data) {
        process.stdout.write(data);
      },
    },
    200,
    body,
  );
}

async function doctor(args) {
  const webviewExists = await exists(args.webviewDir);
  process.stdout.write(`Codex Desktop Linux doctor\n`);
  process.stdout.write(`mode: devcontainer-web\n`);
  process.stdout.write(`workspace: ${args.workspace}\n`);
  process.stdout.write(`profile: ${args.profile}\n`);
  process.stdout.write(`listener_default: loopback-only\n`);
  process.stdout.write(`webview_dir: ${args.webviewDir} (${webviewExists ? "ok" : "missing"})\n`);
  process.stdout.write(`Browser Use: container-chromium or playwright-cdp; current status checked by serve\n`);
  process.stdout.write(`Computer Use: browser-only; physical host desktop control disabled\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "serve") {
    await serve(args);
  } else if (args.command === "inspect") {
    await inspect(args);
  } else if (args.command === "doctor") {
    await doctor(args);
  } else {
    throw new Error(`Unknown command: ${args.command}`);
  }
}

main().catch((error) => {
  console.error(`codex web mode failed: ${error.message}`);
  process.exit(1);
});
