#!/usr/bin/env node

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import http from "node:http";
import net from "node:net";
import { endianness } from "node:os";
import path from "node:path";
import process from "node:process";
import tls from "node:tls";
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
  [".gif", "image/gif"],
  [".avif", "image/avif"],
  [".ico", "image/x-icon"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

const WEB_MODE_API_PREFIXES = [
  "/accounts/",
  "/api/",
  "/aip/",
  "/backend-api/",
  "/beacons/",
  "/checkout_pricing_config/",
  "/files/",
  "/oauth/",
  "/subscriptions/",
  "/wham/",
];

const BUNDLED_PLUGIN_NAMES = ["browser", "chrome", "computer-use", "read-aloud"];
const SHUTDOWN_TIMEOUT_MS = 3000;
const REMOTE_CONTROL_ENROLLMENTS_KEY = "electron-remote-control-client-enrollments";
const REMOTE_CONTROL_PROTOCOL_VERSION = "3";
const REMOTE_CONTROL_REQUIRED_SCOPE = "remote_control_controller_websocket";
const REMOTE_CONTROL_STEP_UP_SCOPE = "codex.remote_control.enroll";
const REMOTE_CONTROL_DEVICE_KEY_ALGORITHM = "ecdsa_p256_sha256";
const REMOTE_CONTROL_DEVICE_KEY_PROTECTION_CLASS = "os_protected_nonextractable";
const REMOTE_CONTROL_DEVICE_KEY_DOMAIN = "codex-device-key-sign-payload/v1";
const REMOTE_CONTROL_SEGMENT_MESSAGE_BYTES = 100 * 1024;
const REMOTE_CONTROL_SEGMENT_ENVELOPE_BYTES = 150 * 1024;
const REMOTE_CONTROL_MAX_REASSEMBLED_BYTES = 1024 * 1024 * 1024;

function redactHome(targetPath) {
  const home = process.env.HOME;
  if (!home || typeof targetPath !== "string") {
    return targetPath;
  }
  return targetPath === home || targetPath.startsWith(`${home}${path.sep}`) ? `~${targetPath.slice(home.length)}` : targetPath;
}

function printServeLine(message = "") {
  process.stderr.write(`${message}\n`);
}

function usage() {
  console.error(`Usage:
  codex-desktop serve --workspace <dir> [--profile <dir>] [--codex-home <dir>|--isolated] [--bind 127.0.0.1] [--port 3773]
  codex-desktop serve status --workspace <dir> [--profile <dir>]
  codex-desktop serve stop --workspace <dir> [--profile <dir>]
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
    codexHome: null,
    isolated: false,
    requireToken: false,
    onceHealthCheck: false,
    mode: null,
  };

  if (argv[0] && !argv[0].startsWith("-")) {
    args.command = argv.shift();
  }
  if (args.command === "serve" && argv[0] && !argv[0].startsWith("-")) {
    const subcommand = argv.shift();
    if (subcommand === "status" || subcommand === "stop") {
      args.command = subcommand;
    } else {
      throw new Error(`Unknown serve subcommand: ${subcommand}`);
    }
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--app-dir") {
      args.appDir = path.resolve(argv[++index] ?? "");
    } else if (arg === "--workspace") {
      args.workspace = path.resolve(argv[++index] ?? "");
    } else if (arg === "--profile") {
      args.profile = path.resolve(argv[++index] ?? "");
    } else if (arg === "--codex-home") {
      args.codexHome = path.resolve(argv[++index] ?? "");
    } else if (arg === "--isolated") {
      args.isolated = true;
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
    } else if (args.command === "serve" && (arg === "status" || arg === "stop")) {
      args.command = arg;
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
  args.codexHome =
    args.codexHome ??
    (args.isolated
      ? path.join(args.profile, "identity", "codex-home")
      : path.resolve(process.env.CODEX_HOME || path.join(process.env.HOME || args.workspace, ".codex")));
  args.webviewDir = path.join(args.appDir, "content", "webview");
  args.bootstrapPath = path.join(args.appDir, ".codex-linux", "web-mode-bootstrap.js");
  args.webHostDir = path.join(args.profile, "run");
  args.logsDir = path.join(args.profile, "logs");
  args.browserProfileDir = path.join(args.profile, "browser");
  args.identityDir = path.join(args.profile, "identity");
  args.runDir = path.join(args.profile, "run");
  args.webStatePath = path.join(args.profile, "web-state.json");
  args.serveStatePath = path.join(args.runDir, "serve.json");

  return args;
}

function isLoopback(bind) {
  return bind === "127.0.0.1" || bind === "localhost" || bind === "::1";
}

function jsonResponse(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store, max-age=0",
    "permissions-policy": "microphone=(self), camera=(self)",
  });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

function textResponse(response, status, body) {
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store, max-age=0",
    "permissions-policy": "microphone=(self), camera=(self)",
  });
  response.end(body);
}

function staticHeaders(contentType) {
  return {
    "content-type": contentType,
    "cache-control": "no-store, max-age=0",
    "permissions-policy": "microphone=(self), camera=(self)",
  };
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
    args.browserProfileDir,
    args.runDir,
    args.logsDir,
    path.join(args.runDir, "browser-use"),
  ]) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  }

  if (args.isolated) {
    for (const directory of [
      args.identityDir,
      args.codexHome,
      path.join(args.identityDir, "xdg-config"),
      path.join(args.identityDir, "xdg-cache"),
      path.join(args.identityDir, "xdg-state"),
    ]) {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    }
  } else {
    await fs.mkdir(args.codexHome, { recursive: true, mode: 0o700 });
  }
}

function truthyEnv(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? ""));
}

function falseyEnv(value) {
  return /^(0|false|no|off)$/i.test(String(value ?? ""));
}

function hasDesktopSessionEnv(env = process.env) {
  return Boolean((env.WAYLAND_DISPLAY || env.DISPLAY) && env.DBUS_SESSION_BUS_ADDRESS && env.XDG_RUNTIME_DIR);
}

function computerUseBrowserOnlyRequested() {
  if (truthyEnv(process.env.CODEX_COMPUTER_USE_BROWSER_ONLY) || process.env.CODEX_COMPUTER_CONTROL_MODE === "browser-only") {
    return true;
  }
  if (process.env.CODEX_COMPUTER_CONTROL_MODE === "desktop" || falseyEnv(process.env.CODEX_COMPUTER_USE_BROWSER_ONLY)) {
    return false;
  }
  return !hasDesktopSessionEnv();
}

function createState(args) {
  const token = crypto.randomBytes(24).toString("base64url");
  const serverId = crypto.randomBytes(16).toString("hex");
  const computerUseBrowserOnly = computerUseBrowserOnlyRequested();
  return {
    args,
    serverId,
    token,
    startedAt: new Date().toISOString(),
    nextRpcId: 1,
    pendingRpc: new Map(),
    notifications: [],
    sseClients: new Set(),
    appListCache: {
      data: null,
      fetchedAtMs: 0,
    },
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
    chrome_native_host: {
      status: "not_checked",
      manifests: [],
    },
    remoteControl: {
      connections: new Map(),
      session: null,
      last_error: null,
    },
    computer: computerUseBrowserOnly
      ? {
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
        }
      : {
          mode: "desktop",
          desktop_control: "enabled",
          physical_host_control: true,
          blocked_host_env: [],
        },
  };
}

function appendServeLog(state, event, fields = {}, level = "info") {
  const entry = {
    at: new Date().toISOString(),
    level,
    event,
    ...fields,
  };
  fs.appendFile(path.join(state.args.logsDir, "serve.jsonl"), `${JSON.stringify(entry)}\n`).catch(() => {});
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
  const computerUseBrowserOnly = computerUseBrowserOnlyRequested();
  const env = {
    ...process.env,
    CODEX_HOME: args.codexHome,
    CODEX_DESKTOP_WEB_MODE: "1",
    CODEX_DESKTOP_DEVCONTAINER_MODE: "1",
    CODEX_BROWSER_MODE: process.env.CODEX_BROWSER_MODE || "container-chromium",
    CODEX_BROWSER_PROFILE_DIR: args.browserProfileDir,
    CODEX_BROWSER_USE_SOCKET_DIR: path.join(args.runDir, "browser-use"),
    CODEX_COMPUTER_USE_BROWSER_ONLY: computerUseBrowserOnly ? "1" : "0",
    CODEX_COMPUTER_CONTROL_MODE: computerUseBrowserOnly ? "browser-only" : process.env.CODEX_COMPUTER_CONTROL_MODE || "desktop",
  };

  if (args.isolated) {
    env.XDG_CONFIG_HOME = path.join(args.identityDir, "xdg-config");
    env.XDG_CACHE_HOME = path.join(args.identityDir, "xdg-cache");
    env.XDG_STATE_HOME = path.join(args.identityDir, "xdg-state");
  }

  if (computerUseBrowserOnly) {
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

async function chooseFreeLoopbackPort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address != null ? address.port : null;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

function configuredCdpPort() {
  if (!process.env.CODEX_BROWSER_CDP_PORT) {
    return null;
  }
  const port = Number.parseInt(process.env.CODEX_BROWSER_CDP_PORT, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("CODEX_BROWSER_CDP_PORT must be between 1 and 65535");
  }
  return port;
}

function writeNativePipeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  if (endianness() === "LE") {
    header.writeUInt32LE(body.length, 0);
  } else {
    header.writeUInt32BE(body.length, 0);
  }
  return Buffer.concat([header, body]);
}

function readFrameLength(buffer) {
  return endianness() === "LE" ? buffer.readUInt32LE(0) : buffer.readUInt32BE(0);
}

class NativePipeFrameDecoder {
  chunks = [];
  byteLength = 0;

  push(chunk) {
    if (chunk.byteLength > 0) {
      const buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      this.chunks.push(buffer);
      this.byteLength += buffer.byteLength;
    }

    const frames = [];
    while (this.byteLength >= 4) {
      const header = this.peek(4);
      const length = readFrameLength(header);
      const frameLength = 4 + length;
      if (this.byteLength < frameLength) {
        break;
      }
      frames.push(JSON.parse(this.consume(frameLength).subarray(4).toString("utf8")));
    }
    return frames;
  }

  peek(size) {
    if (this.chunks[0]?.byteLength >= size) {
      return this.chunks[0].subarray(0, size);
    }
    const buffer = Buffer.allocUnsafe(size);
    let offset = 0;
    for (const chunk of this.chunks) {
      offset += chunk.copy(buffer, offset, 0, size - offset);
      if (offset === size) {
        break;
      }
    }
    return buffer;
  }

  consume(size) {
    const buffer = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const chunk = this.chunks[0];
      if (!chunk) {
        throw new Error("native pipe frame underflow");
      }
      const copied = chunk.copy(buffer, offset, 0, size - offset);
      offset += copied;
      this.byteLength -= copied;
      if (copied === chunk.byteLength) {
        this.chunks.shift();
      } else {
        this.chunks[0] = chunk.subarray(copied);
      }
    }
    return buffer;
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 3000),
  });
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }
  return await response.json();
}

function cdpUrl(endpoint, pathname) {
  const url = new URL(pathname, endpoint.endsWith("/") ? endpoint : `${endpoint}/`);
  return url.toString();
}

class CdpConnection {
  constructor(backend, tabId, target) {
    this.backend = backend;
    this.tabId = tabId;
    this.target = target;
  }

  nextId = 1;
  pending = new Map();
  targetSessions = new Map();
  actualSessions = new Map();
  ws = null;
  opening = null;

  async ensureOpen() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return;
    }
    if (typeof WebSocket !== "function") {
      throw new Error("Node.js WebSocket runtime is unavailable");
    }
    this.opening ??= (async () => {
      const target = await this.backend.targetForTabId(this.tabId);
      if (!target?.webSocketDebuggerUrl) {
        throw new Error(`CDP target ${this.tabId} has no websocket debugger URL`);
      }
      this.target = target;
      const ws = new WebSocket(target.webSocketDebuggerUrl);
      this.ws = ws;
      await new Promise((resolve, reject) => {
        const fail = (event) => reject(new Error(event?.message ?? "CDP websocket failed to open"));
        ws.addEventListener("open", resolve, { once: true });
        ws.addEventListener("error", fail, { once: true });
      });
      ws.addEventListener("message", (event) => this.handleMessage(event.data));
      ws.addEventListener("close", () => this.rejectAll(new Error("CDP websocket closed")));
    })().finally(() => {
      this.opening = null;
    });
    await this.opening;
  }

  handleMessage(data) {
    let message;
    try {
      message = JSON.parse(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
    } catch {
      return;
    }

    if (message.id != null && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? "CDP request failed"));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if (typeof message.method === "string") {
      const source = { tabId: this.tabId };
      if (typeof message.sessionId === "string") {
        source.sessionId = this.actualSessions.get(message.sessionId) ?? message.sessionId;
      }
      this.backend.broadcast({
        jsonrpc: "2.0",
        method: "onCDPEvent",
        params: {
          source,
          method: message.method,
          params: message.params ?? {},
        },
      });
    }
  }

  async call(method, params = {}, { sessionId = null, timeoutMs = 30000 } = {}) {
    await this.ensureOpen();
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) {
      payload.sessionId = sessionId;
    }
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.ws.send(JSON.stringify(payload));
    return await response;
  }

  async attachTarget(targetId) {
    const existing = this.targetSessions.get(targetId);
    if (existing) {
      return existing;
    }
    const result = await this.call("Target.attachToTarget", { targetId, flatten: true });
    const actualSessionId = result.sessionId;
    if (typeof actualSessionId !== "string" || actualSessionId.length === 0) {
      throw new Error(`Target.attachToTarget did not return a session for ${targetId}`);
    }
    const syntheticSessionId = `target:${targetId}`;
    this.targetSessions.set(targetId, actualSessionId);
    this.actualSessions.set(actualSessionId, syntheticSessionId);
    return actualSessionId;
  }

  async detachTarget(targetId) {
    const actualSessionId = this.targetSessions.get(targetId);
    if (!actualSessionId) {
      return;
    }
    await this.call("Target.detachFromTarget", { sessionId: actualSessionId }).catch(() => {});
    this.targetSessions.delete(targetId);
    this.actualSessions.delete(actualSessionId);
  }

  sessionForTarget(targetId) {
    return this.targetSessions.get(targetId) ?? null;
  }

  sessionForSynthetic(sessionId) {
    if (typeof sessionId !== "string" || !sessionId.startsWith("target:")) {
      return sessionId;
    }
    return this.targetSessions.get(sessionId.slice("target:".length)) ?? null;
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async close() {
    this.rejectAll(new Error("CDP connection closed"));
    this.ws?.close();
    this.ws = null;
  }
}

class CdpNativePipeBackend {
  constructor(state) {
    this.state = state;
    this.endpoint = state.browser.cdp_endpoint;
    this.socketDir = state.browser.socket_dir ?? path.join(state.args.runDir, "browser-use");
    this.socketPath = path.join(this.socketDir, `codex-web-cdp-${process.pid}.sock`);
  }

  clients = new Set();
  tabIdByTargetId = new Map();
  targetByTabId = new Map();
  connections = new Map();
  nextTabId = 1;
  activeTabId = null;
  server = null;

  async start() {
    if (!this.endpoint || this.state.browser.mode === "disabled") {
      return;
    }
    if (typeof WebSocket !== "function") {
      this.state.browser.native_pipe = { status: "disabled", reason: "Node.js WebSocket runtime is unavailable" };
      return;
    }
    await fs.mkdir(this.socketDir, { recursive: true, mode: 0o700 });
    await fs.rm(this.socketPath, { force: true });
    this.server = net.createServer((socket) => this.handleSocket(socket));
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.socketPath, resolve);
    });
    await fs.chmod(this.socketPath, 0o600).catch(() => {});
    this.state.browser.native_pipe = {
      status: "listening",
      backend: "cdp",
      socket_path: this.socketPath,
      socket_dir: this.socketDir,
    };
    this.state.browser.available_backends = ["cdp"];
  }

  async stop() {
    for (const client of this.clients) {
      client.destroy();
    }
    this.clients.clear();
    await Promise.allSettled([...this.connections.values()].map((connection) => connection.close()));
    this.connections.clear();
    if (this.server?.listening) {
      await new Promise((resolve) => this.server.close(resolve));
    }
    await fs.rm(this.socketPath, { force: true }).catch(() => {});
  }

  handleSocket(socket) {
    const decoder = new NativePipeFrameDecoder();
    this.clients.add(socket);
    socket.on("data", (chunk) => {
      let messages;
      try {
        messages = decoder.push(chunk);
      } catch (error) {
        this.send(socket, { jsonrpc: "2.0", error: { code: -32700, message: error.message } });
        return;
      }
      for (const message of messages) {
        void this.handleMessage(socket, message);
      }
    });
    socket.on("close", () => this.clients.delete(socket));
    socket.on("error", () => this.clients.delete(socket));
  }

  send(socket, message) {
    if (!socket.destroyed) {
      socket.write(writeNativePipeFrame(message));
    }
  }

  broadcast(message) {
    for (const client of this.clients) {
      this.send(client, message);
    }
  }

  async handleMessage(socket, message) {
    if (typeof message?.method !== "string" || message.id == null) {
      return;
    }
    try {
      const result = await this.handleRequest(message.method, message.params ?? {});
      this.send(socket, { jsonrpc: "2.0", id: message.id, result });
    } catch (error) {
      this.send(socket, {
        jsonrpc: "2.0",
        id: message.id,
        error: { code: 1, message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  async handleRequest(method, params) {
    switch (method) {
      case "ping":
        return "pong";
      case "getInfo":
        return {
          type: "cdp",
          name: "Container Chromium",
          capabilities: {
            browser: ["create_tab", "list_tabs", "name_session"].map((id) => ({ id })),
            tab: [
              "navigate_tab_url",
              "navigate_tab_back",
              "navigate_tab_forward",
              "navigate_tab_reload",
              "close_tab",
              "tab_screenshot",
              "playwright_evaluate",
              "playwright_locator_click",
              "playwright_locator_fill",
              "dom_cua_click",
              "dom_cua_type",
            ].map((id) => ({ id })),
          },
          metadata: { cdpEndpoint: this.endpoint },
        };
      case "getTabs":
        return await this.getTabs();
      case "createTab":
        return await this.createTab();
      case "attach":
        await this.connectionForTab(Number(params.tabId));
        return {};
      case "detach":
        return {};
      case "attachTarget":
        await (await this.connectionForTab(Number(params.tabId))).attachTarget(params.targetId);
        return {};
      case "detachTarget":
        await (await this.connectionForTab(Number(params.tabId))).detachTarget(params.targetId);
        return {};
      case "executeCdp":
        return await this.executeCdp(params);
      case "getUserTabs":
      case "getUserHistory":
        return [];
      case "claimUserTab":
        return { claimed: false };
      case "finalizeTabs":
      case "nameSession":
      case "moveMouse":
        return {};
      default:
        throw new Error(`Unsupported CDP browser backend method: ${method}`);
    }
  }

  async cdpTargets() {
    return (await fetchJson(cdpUrl(this.endpoint, "/json/list"), { timeoutMs: 3000 })).filter(
      (target) => target?.type === "page",
    );
  }

  tabForTarget(target) {
    let tabId = this.tabIdByTargetId.get(target.id);
    if (tabId == null) {
      tabId = this.nextTabId++;
      this.tabIdByTargetId.set(target.id, tabId);
    }
    this.targetByTabId.set(tabId, target);
    if (this.activeTabId == null) {
      this.activeTabId = tabId;
    }
    return {
      id: tabId,
      title: target.title ?? "",
      url: target.url ?? "",
      active: tabId === this.activeTabId,
      targetId: target.id,
    };
  }

  async getTabs() {
    const tabs = (await this.cdpTargets()).map((target) => this.tabForTarget(target));
    if (tabs.length === 0) {
      return [await this.createTab()];
    }
    return tabs;
  }

  async createTab() {
    const encodedUrl = encodeURIComponent("about:blank");
    let target;
    try {
      target = await fetchJson(cdpUrl(this.endpoint, `/json/new?${encodedUrl}`), { method: "PUT", timeoutMs: 3000 });
    } catch {
      target = await fetchJson(cdpUrl(this.endpoint, `/json/new?${encodedUrl}`), { timeoutMs: 3000 });
    }
    const tab = this.tabForTarget(target);
    this.activeTabId = tab.id;
    return { ...tab, active: true };
  }

  async targetForTabId(tabId) {
    if (!Number.isInteger(tabId) || tabId <= 0) {
      throw new Error(`invalid tab id: ${tabId}`);
    }
    const existing = this.targetByTabId.get(tabId);
    if (existing) {
      return existing;
    }
    await this.getTabs();
    const target = this.targetByTabId.get(tabId);
    if (!target) {
      throw new Error(`CDP tab not found: ${tabId}`);
    }
    return target;
  }

  async connectionForTab(tabId) {
    await this.targetForTabId(tabId);
    let connection = this.connections.get(tabId);
    if (!connection) {
      connection = new CdpConnection(this, tabId, this.targetByTabId.get(tabId));
      this.connections.set(tabId, connection);
    }
    await connection.ensureOpen();
    this.activeTabId = tabId;
    return connection;
  }

  async executeCdp(params) {
    const target = params.target ?? {};
    const tabId = Number(target.tabId);
    const connection = await this.connectionForTab(tabId);
    let sessionId = null;
    if (typeof target.targetId === "string" && target.targetId.length > 0) {
      sessionId = connection.sessionForTarget(target.targetId) ?? (await connection.attachTarget(target.targetId));
    } else if (typeof target.sessionId === "string" && target.sessionId.length > 0) {
      sessionId = connection.sessionForSynthetic(target.sessionId);
    }
    return await connection.call(params.method, params.commandParams ?? {}, {
      sessionId,
      timeoutMs: Number.isFinite(params.timeoutMs) ? params.timeoutMs : 30000,
    });
  }
}

async function startBrowserSidecar(state) {
  const explicitEndpoint = process.env.CODEX_BROWSER_CDP_ENDPOINT;
  if (explicitEndpoint) {
    state.browser = {
      mode: "playwright-cdp",
      reason: "using explicit CODEX_BROWSER_CDP_ENDPOINT",
      profile_dir: state.args.browserProfileDir,
      cdp_endpoint: explicitEndpoint,
      socket_dir: path.join(state.args.runDir, "browser-use"),
      pid: null,
    };
    process.env.CODEX_BROWSER_USE_SOCKET_DIR = state.browser.socket_dir;
    await startCdpNativePipeBackend(state);
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

  const cdpPort = configuredCdpPort() ?? (await chooseFreeLoopbackPort());
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
    await startCdpNativePipeBackend(state);
  } catch (error) {
    state.browser.mode = "disabled";
    state.browser.reason = `container Chromium/CDP sidecar failed readiness: ${error.message}`;
    state.browser.cdp_ready = false;
  }
}

async function startCdpNativePipeBackend(state) {
  if (!state.browser.cdp_endpoint || state.browser.mode === "disabled") {
    return;
  }
  const backend = new CdpNativePipeBackend(state);
  try {
    await backend.start();
    state.browser.cdpPipe = backend;
    appendServeLog(state, "browser_native_pipe_ready", state.browser.native_pipe);
  } catch (error) {
    state.browser.native_pipe = { status: "error", backend: "cdp", reason: error.message };
    appendServeLog(state, "browser_native_pipe_failed", { error: error.message }, "warn");
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

async function stopBrowserSidecar(state) {
  await state.browser.cdpPipe?.stop?.().catch((error) => appendServeLog(state, "browser_native_pipe_stop_failed", { error: error.message }, "warn"));
  await terminateChild(state.browser.child, "browser sidecar");
}

async function sendAppServerRpc(state, method, params = {}, timeoutMs = 30000) {
  const stdin = state.appServer.child?.stdin;
  if (!stdin?.writable) {
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

  const rejectWrite = (error) => {
    const pending = state.pendingRpc.get(id);
    if (!pending) {
      return;
    }
    state.pendingRpc.delete(id);
    pending.reject(error instanceof Error ? error : new Error(String(error)));
  };
  try {
    stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error) {
        rejectWrite(error);
      }
    });
  } catch (error) {
    rejectWrite(error);
  }
  return response;
}

function webModePlanType(value) {
  if (typeof value !== "string") {
    return null;
  }
  return value.replace(/[A-Z]/g, (match) => `_${match.toLowerCase()}`).toLowerCase();
}

function webModeAccountId(account) {
  const id = account?.id ?? account?.userId ?? account?.email ?? null;
  return id == null || String(id).trim().length === 0 ? "default" : String(id);
}

function webModeWhamAccountFromAppServerAccount(account) {
  const id = webModeAccountId(account);
  return {
    id,
    email: account?.email ?? null,
    name: account?.name ?? null,
    structure: "personal",
    plan_type: webModePlanType(account?.planType ?? account?.plan_type),
    profile_picture_url: account?.profilePictureUrl ?? account?.profile_picture_url ?? null,
  };
}

function webModeWhamAccountsCheckResponse(accountResult) {
  const account = webModeWhamAccountFromAppServerAccount(accountResult?.account ?? {});
  return {
    account_ordering: [account.id],
    accounts: [account],
  };
}

function webModeWhamCredits(credits) {
  if (credits == null) {
    return null;
  }
  return {
    has_credits: credits.hasCredits ?? credits.has_credits ?? false,
    unlimited: credits.unlimited ?? false,
    balance: credits.balance ?? null,
  };
}

function webModeWhamRateLimitWindow(window) {
  if (window == null) {
    return null;
  }
  const windowDurationMins = window.windowDurationMins ?? window.window_duration_mins ?? null;
  return {
    used_percent: window.usedPercent ?? window.used_percent ?? 0,
    limit_window_seconds: Number.isFinite(windowDurationMins) ? windowDurationMins * 60 : null,
    reset_at: window.resetsAt ?? window.reset_at ?? null,
  };
}

function webModeWhamRateLimit(limit) {
  if (limit == null) {
    return null;
  }
  const rateLimitReachedType = limit.rateLimitReachedType ?? limit.rate_limit_reached_type ?? null;
  return {
    primary_window: webModeWhamRateLimitWindow(limit.primary),
    secondary_window: webModeWhamRateLimitWindow(limit.secondary),
    allowed: rateLimitReachedType == null,
    limit_reached: rateLimitReachedType != null,
  };
}

function webModeWhamAdditionalRateLimit(limit) {
  const rateLimit = webModeWhamRateLimit(limit);
  const limitName = limit?.limitName ?? limit?.limit_name ?? null;
  if (rateLimit == null || limitName == null || String(limitName).trim().length === 0) {
    return null;
  }
  return {
    limit_name: String(limitName),
    rate_limit: rateLimit,
  };
}

function webModeWhamUsageResponse(rateLimitResult, accountResult = null) {
  const primaryLimit = rateLimitResult?.rateLimits ?? rateLimitResult?.rate_limits ?? null;
  const limitsById = rateLimitResult?.rateLimitsByLimitId ?? rateLimitResult?.rate_limits_by_limit_id ?? {};
  const additionalRateLimits = Object.values(limitsById)
    .filter((limit) => limit !== primaryLimit && (limit?.limitName ?? limit?.limit_name) != null)
    .map(webModeWhamAdditionalRateLimit)
    .filter(Boolean);
  const account = accountResult?.account ?? {};
  const planType = webModePlanType(primaryLimit?.planType ?? primaryLimit?.plan_type ?? account?.planType ?? account?.plan_type);
  return {
    account_id: webModeAccountId(account),
    plan_type: planType,
    rate_limit_name: primaryLimit?.limitName ?? primaryLimit?.limit_name ?? null,
    rate_limit: webModeWhamRateLimit(primaryLimit),
    additional_rate_limits: additionalRateLimits,
    credits: webModeWhamCredits(primaryLimit?.credits),
    rate_limit_reached_type: primaryLimit?.rateLimitReachedType ?? primaryLimit?.rate_limit_reached_type ?? null,
  };
}

function stableWebModeId(prefix, value) {
  return `${prefix}-${crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 24)}`;
}

function jwtPayload(token) {
  if (typeof token !== "string") {
    return null;
  }
  const parts = token.split(".");
  if (parts.length < 2 || !parts[1]) {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function authClaimFromToken(token) {
  const payload = jwtPayload(token);
  const claim = payload?.["https://api.openai.com/auth"];
  return claim && typeof claim === "object" && !Array.isArray(claim) ? claim : {};
}

function tokenExpiresSoon(token, nowMs = Date.now()) {
  const exp = jwtPayload(token)?.exp;
  return typeof exp === "number" && exp * 1000 <= nowMs + 60_000;
}

async function readCodexAuth(args) {
  try {
    const auth = await readJsonFile(path.join(args.codexHome, "auth.json"));
    return auth && typeof auth === "object" && !Array.isArray(auth) ? auth : {};
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function accessTokenForRemoteControl(state, { refreshToken = false } = {}) {
  let auth = await readCodexAuth(state.args);
  let token = auth.tokens?.access_token;
  if ((refreshToken || tokenExpiresSoon(token)) && state.appServer.child) {
    await sendAppServerRpc(state, "account/read", { refreshToken: true }).catch(() => null);
    auth = await readCodexAuth(state.args);
    token = auth.tokens?.access_token;
  }
  return typeof token === "string" && token.trim().length > 0 ? token : null;
}

function remoteControlApiBaseUrl() {
  const override = process.env.CODEX_API_BASE_URL?.trim();
  if (override) {
    return override.replace(/\/+$/, "");
  }
  return (process.env.CODEX_API_ENDPOINT ?? "").toLowerCase() === "localhost"
    ? "http://localhost:8000/api"
    : "https://chatgpt.com/backend-api";
}

function remoteControlApiUrl(apiPath) {
  return `${remoteControlApiBaseUrl()}/${String(apiPath).replace(/^\/+/, "")}`;
}

async function remoteControlAuthHeaders(state, { headers = {}, refreshToken = false } = {}) {
  const token = await accessTokenForRemoteControl(state, { refreshToken });
  if (!token) {
    throw Object.assign(new Error("Sign in to ChatGPT in Codex Desktop to load remote control environments."), {
      statusCode: 401,
      remoteControlKind: "auth_required",
    });
  }
  const authClaim = authClaimFromToken(token);
  const accountId = authClaim.chatgpt_account_id ?? authClaim.account_id ?? (await readCodexAuth(state.args)).tokens?.account_id;
  return {
    ...headers,
    Authorization: `Bearer ${token}`,
    ...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
    originator: "Codex Desktop",
    "User-Agent": `Codex Desktop Web (Linux; ${process.arch})`,
  };
}

async function remoteControlApiFetch(state, apiPath, options = {}) {
  const method = options.method ?? "GET";
  let headers = await remoteControlAuthHeaders(state, {
    headers: options.headers ?? {},
    refreshToken: false,
  });
  let response = await fetch(remoteControlApiUrl(apiPath), {
    method,
    headers,
    body: options.body == null ? undefined : JSON.stringify(options.body),
  });
  if (response.status === 401) {
    headers = await remoteControlAuthHeaders(state, {
      headers: options.headers ?? {},
      refreshToken: true,
    });
    response = await fetch(remoteControlApiUrl(apiPath), {
      method,
      headers,
      body: options.body == null ? undefined : JSON.stringify(options.body),
    });
  }
  return response;
}

async function remoteControlResponseText(response) {
  try {
    return await response.text();
  } catch {
    return response.statusText || "Unknown error";
  }
}

async function remoteControlJsonResponse(response) {
  const text = await remoteControlResponseText(response);
  if (!text) {
    return {};
  }
  return JSON.parse(text);
}

function remoteControlWebSocketUrl() {
  const url = new URL(remoteControlApiUrl("/codex/remote/control/client"));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function httpTargetForWebSocketUrl(websocketUrl) {
  const url = new URL(websocketUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  return url;
}

function remoteControlConnectionKey() {
  const baseUrl = remoteControlApiBaseUrl();
  return ["Codex Desktop", baseUrl, baseUrl].join("\n");
}

function remoteControlChallengeField(challenge, snakeName, camelName = snakeName.replace(/_([a-z])/g, (_, char) => char.toUpperCase())) {
  return challenge?.[snakeName] ?? challenge?.[camelName] ?? null;
}

function remoteControlDateMs(value) {
  const time = Date.parse(String(value ?? ""));
  return Number.isFinite(time) ? time : null;
}

function remoteControlTimestampSeconds(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  const timeMs = remoteControlDateMs(value);
  return timeMs == null ? null : Math.floor(timeMs / 1000);
}

function remoteControlScopeList(value) {
  if (Array.isArray(value)) {
    return value.map(String);
  }
  if (typeof value === "string") {
    return value.split(/\s+/).filter(Boolean);
  }
  return [];
}

function remoteControlStepUpTokenFrom(params = {}) {
  return (
    params.stepUpToken ??
    params.step_up_token ??
    process.env.CODEX_WEB_MODE_REMOTE_CONTROL_STEP_UP_TOKEN ??
    process.env.CODEX_REMOTE_CONTROL_STEP_UP_TOKEN ??
    null
  );
}

function validateRemoteControlStepUpToken(token, { accountId, accountUserId }) {
  const payload = jwtPayload(token);
  if (!payload) {
    throw Object.assign(new Error("remote-control step-up token is not a JWT"), { remoteControlKind: "auth_required", statusCode: 401 });
  }
  const nowSeconds = Date.now() / 1000;
  if (typeof payload.exp === "number" && payload.exp <= nowSeconds) {
    throw Object.assign(new Error("remote-control step-up token is expired"), { remoteControlKind: "auth_required", statusCode: 401 });
  }
  if (typeof payload.iat === "number" && payload.iat < nowSeconds - 300) {
    throw Object.assign(new Error("remote-control step-up token is too old"), { remoteControlKind: "auth_required", statusCode: 401 });
  }
  if (typeof payload.pwd_auth_time === "number" && payload.pwd_auth_time < nowSeconds - 300) {
    throw Object.assign(new Error("remote-control step-up token needs fresh authentication"), {
      remoteControlKind: "auth_required",
      statusCode: 401,
    });
  }
  const scopes = remoteControlScopeList(payload.scope ?? payload.scp);
  if (!scopes.includes(REMOTE_CONTROL_STEP_UP_SCOPE)) {
    throw Object.assign(new Error(`remote-control step-up token needs ${REMOTE_CONTROL_STEP_UP_SCOPE}`), {
      remoteControlKind: "auth_required",
      statusCode: 401,
    });
  }
  const claim = authClaimFromToken(token);
  const tokenAccountId = claim.chatgpt_account_id ?? claim.account_id;
  const tokenAccountUserId = claim.chatgpt_account_user_id ?? claim.account_user_id ?? claim.user_id ?? payload.sub;
  if (accountId && tokenAccountId && tokenAccountId !== accountId) {
    throw Object.assign(new Error("remote-control step-up token account does not match the active Codex account"), {
      remoteControlKind: "auth_required",
      statusCode: 401,
    });
  }
  if (accountUserId && tokenAccountUserId && tokenAccountUserId !== accountUserId) {
    throw Object.assign(new Error("remote-control step-up token user does not match the active Codex account"), {
      remoteControlKind: "auth_required",
      statusCode: 401,
    });
  }
  return payload;
}

async function remoteControlAccountIdentity(state) {
  const token = await accessTokenForRemoteControl(state);
  if (!token) {
    throw Object.assign(new Error("Sign in to ChatGPT in Codex Desktop to authorize remote control."), {
      remoteControlKind: "auth_required",
      statusCode: 401,
    });
  }
  const claim = authClaimFromToken(token);
  return {
    accountId: claim.chatgpt_account_id ?? claim.account_id ?? (await readCodexAuth(state.args)).tokens?.account_id ?? null,
    accountUserId: claim.chatgpt_account_user_id ?? claim.account_user_id ?? claim.user_id ?? jwtPayload(token)?.sub ?? null,
  };
}

function remoteControlDeviceKeyStorePath(state) {
  if (state.args.isolated) {
    return path.join(state.args.identityDir, "xdg-config", "codex-desktop", "remote-control-device-keys-v1.json");
  }
  const configHome =
    process.env.XDG_CONFIG_HOME?.trim() ||
    (process.env.HOME ? path.join(process.env.HOME, ".config") : path.join(state.args.identityDir, "xdg-config"));
  return path.join(configHome, "codex-desktop", "remote-control-device-keys-v1.json");
}

async function readRemoteControlDeviceKeyStore(state) {
  try {
    const store = await readJsonFile(remoteControlDeviceKeyStorePath(state));
    return store && typeof store === "object" && !Array.isArray(store) ? store : {};
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function writeRemoteControlDeviceKeyStore(state, store) {
  const storePath = remoteControlDeviceKeyStorePath(state);
  await fs.mkdir(path.dirname(storePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

function remoteControlDeviceIdentityForKey(record) {
  return {
    key_id: record.key_id ?? record.keyId,
    public_key_spki_der_base64: record.public_key_spki_der_base64 ?? record.publicKeySpkiDerBase64,
    algorithm: record.algorithm ?? REMOTE_CONTROL_DEVICE_KEY_ALGORITHM,
    protection_class: record.protection_class ?? record.protectionClass ?? REMOTE_CONTROL_DEVICE_KEY_PROTECTION_CLASS,
  };
}

function remoteControlDeviceIdentityHash(identity) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        algorithm: identity.algorithm,
        keyId: identity.key_id,
        protectionClass: identity.protection_class,
        publicKeySpkiDerBase64: identity.public_key_spki_der_base64,
      }),
    )
    .digest("base64url");
}

async function ensureRemoteControlDeviceKey(state, keyId = null) {
  const store = await readRemoteControlDeviceKeyStore(state);
  const keys = store.keys && typeof store.keys === "object" && !Array.isArray(store.keys) ? store.keys : {};
  if (keyId && keys[keyId]) {
    return keys[keyId];
  }
  const existing = Object.values(keys).find((record) => record?.algorithm === REMOTE_CONTROL_DEVICE_KEY_ALGORITHM);
  if (existing) {
    return existing;
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const newKeyId = crypto.randomUUID();
  const record = {
    algorithm: REMOTE_CONTROL_DEVICE_KEY_ALGORITHM,
    keyId: newKeyId,
    protectionClass: REMOTE_CONTROL_DEVICE_KEY_PROTECTION_CLASS,
    publicKeySpkiDerBase64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKeyPkcs8Pem: privateKey.export({ type: "pkcs8", format: "pem" }),
    createdAt: new Date().toISOString(),
  };
  keys[record.keyId] = record;
  await writeRemoteControlDeviceKeyStore(state, { ...store, keys });
  return record;
}

function remoteControlSignedPayload(payload) {
  return {
    domain: REMOTE_CONTROL_DEVICE_KEY_DOMAIN,
    payload,
  };
}

function signRemoteControlDeviceKey(keyRecord, payload) {
  const signedPayload = JSON.stringify(remoteControlSignedPayload(payload));
  const signer = crypto.createSign("sha256");
  signer.update(Buffer.from(signedPayload, "utf8"));
  signer.end();
  const privateKey = crypto.createPrivateKey({
    key: keyRecord.privateKeyPkcs8Pem ?? Buffer.from(keyRecord.private_key_pkcs8_der_base64, "base64"),
    format: keyRecord.privateKeyPkcs8Pem ? "pem" : "der",
    type: "pkcs8",
  });
  return {
    keyId: keyRecord.key_id ?? keyRecord.keyId,
    signatureDerBase64: signer.sign(privateKey).toString("base64"),
    signedPayloadBase64: Buffer.from(signedPayload, "utf8").toString("base64"),
    algorithm: REMOTE_CONTROL_DEVICE_KEY_ALGORITHM,
  };
}

function signRemoteControlEnrollmentProof(keyRecord, challenge, payload) {
  const signature = signRemoteControlDeviceKey(keyRecord, payload);
  return {
    challenge_token: remoteControlChallengeField(challenge, "challenge_token"),
    key_id: signature.keyId,
    signature_der_base64: signature.signatureDerBase64,
    signed_payload_base64: signature.signedPayloadBase64,
    algorithm: signature.algorithm,
  };
}

function signRemoteControlWebSocketProof(keyRecord, payload) {
  return {
    type: "device_key_proof",
    ...signRemoteControlDeviceKey(keyRecord, payload),
  };
}

function remoteControlEnvelopeByteLength(envelope) {
  return Buffer.byteLength(JSON.stringify(envelope), "utf8");
}

function remoteControlSegmentEnvelope(envelope) {
  if (envelope.type !== "client_message" || remoteControlEnvelopeByteLength(envelope) <= REMOTE_CONTROL_SEGMENT_MESSAGE_BYTES) {
    return [envelope];
  }
  const messageBytes = Buffer.from(JSON.stringify(envelope.message), "utf8");
  let segmentCount = Math.max(1, Math.ceil(messageBytes.length / REMOTE_CONTROL_SEGMENT_MESSAGE_BYTES));
  for (;;) {
    const chunkSize = Math.max(1, Math.ceil(messageBytes.length / segmentCount));
    const chunks = [];
    for (let offset = 0; offset < messageBytes.length; offset += chunkSize) {
      chunks.push(messageBytes.subarray(offset, offset + chunkSize));
    }
    segmentCount = chunks.length;
    const envelopes = chunks.map((chunk, segmentId) => ({
      ...envelope,
      type: "client_message_chunk",
      message: undefined,
      segment_id: segmentId,
      segment_count: segmentCount,
      message_size_bytes: messageBytes.length,
      message_chunk_base64: chunk.toString("base64"),
    }));
    if (envelopes.every((item) => remoteControlEnvelopeByteLength(item) <= REMOTE_CONTROL_SEGMENT_ENVELOPE_BYTES)) {
      return envelopes;
    }
    if (chunkSize === 1) {
      throw new Error("remote-control client message is too large to segment");
    }
    segmentCount += 1;
  }
}

function assertRemoteControlChallengeTarget(challenge, targetUrl) {
  const expectedTarget = targetUrl.protocol === "wss:" || targetUrl.protocol === "ws:" ? httpTargetForWebSocketUrl(targetUrl.toString()) : targetUrl;
  const targetOrigin = remoteControlChallengeField(challenge, "target_origin");
  const targetPath = remoteControlChallengeField(challenge, "target_path");
  if (!targetOrigin || !targetPath) {
    throw new Error("remote-control device challenge is missing target fields");
  }
  if (targetOrigin !== expectedTarget.origin) {
    throw new Error(`remote-control device challenge target origin mismatch: ${targetOrigin}`);
  }
  if (targetPath !== expectedTarget.pathname) {
    throw new Error(`remote-control device challenge target path mismatch: ${targetPath}`);
  }
}

function assertRemoteControlEnrollmentChallenge(challenge, { clientId, accountUserId, targetUrl, requireDeviceIdentityHash = false, identityHash = null }) {
  if (remoteControlChallengeField(challenge, "purpose") !== "remote_control_client_enrollment") {
    throw new Error("remote-control enrollment challenge has unexpected purpose");
  }
  if (remoteControlChallengeField(challenge, "audience") !== "remote_control_client_enrollment") {
    throw new Error("remote-control enrollment challenge has unexpected audience");
  }
  if (remoteControlChallengeField(challenge, "client_id") !== clientId) {
    throw new Error("remote-control enrollment challenge client does not match");
  }
  if (remoteControlChallengeField(challenge, "account_user_id") !== accountUserId) {
    throw new Error("remote-control enrollment challenge account user does not match");
  }
  if (!remoteControlChallengeField(challenge, "nonce") || !remoteControlChallengeField(challenge, "challenge_token")) {
    throw new Error("remote-control enrollment challenge is missing required nonce or challenge token");
  }
  const expiresAt = remoteControlTimestampSeconds(remoteControlChallengeField(challenge, "challenge_expires_at"));
  if (expiresAt == null || expiresAt <= Math.floor(Date.now() / 1000)) {
    throw new Error("remote-control enrollment challenge is expired");
  }
  if (requireDeviceIdentityHash && !remoteControlChallengeField(challenge, "device_identity_hash")) {
    throw new Error("remote-control enrollment challenge is missing device identity hash");
  }
  if (identityHash && remoteControlChallengeField(challenge, "device_identity_hash") && remoteControlChallengeField(challenge, "device_identity_hash") !== identityHash) {
    throw new Error("remote-control enrollment challenge device identity hash does not match");
  }
  assertRemoteControlChallengeTarget(challenge, targetUrl);
}

function remoteControlEnrollmentProofPayload(challenge, clientId, accountUserId, deviceIdentity) {
  return {
    type: "remoteControlClientEnrollment",
    nonce: remoteControlChallengeField(challenge, "nonce"),
    audience: remoteControlChallengeField(challenge, "audience"),
    challengeId: remoteControlChallengeField(challenge, "challenge_id"),
    targetOrigin: remoteControlChallengeField(challenge, "target_origin"),
    targetPath: remoteControlChallengeField(challenge, "target_path"),
    accountUserId,
    clientId,
    deviceIdentitySha256Base64url: remoteControlDeviceIdentityHash(deviceIdentity),
    challengeExpiresAt: remoteControlChallengeField(challenge, "challenge_expires_at"),
  };
}

function remoteControlConnectionProofPayload(challenge, session, websocketUrl) {
  const target = httpTargetForWebSocketUrl(websocketUrl);
  assertRemoteControlChallengeTarget(challenge, target);
  if (remoteControlChallengeField(challenge, "purpose") !== "remote_control_client_websocket") {
    throw new Error("remote-control websocket challenge has unexpected purpose");
  }
  if (remoteControlChallengeField(challenge, "audience") !== "remote_control_client_websocket") {
    throw new Error("remote-control websocket challenge has unexpected audience");
  }
  if (!remoteControlChallengeField(challenge, "nonce")) {
    throw new Error("remote-control websocket challenge is missing nonce");
  }
  if (remoteControlChallengeField(challenge, "account_user_id") !== session.accountUserId) {
    throw new Error("remote-control websocket challenge account user does not match");
  }
  if (remoteControlChallengeField(challenge, "client_id") !== session.clientId) {
    throw new Error("remote-control websocket challenge client does not match");
  }
  const expectedTokenHash = crypto.createHash("sha256").update(session.remoteControlToken).digest("base64url");
  const challengeTokenHash = remoteControlChallengeField(challenge, "token_sha256_base64url");
  if (!challengeTokenHash || challengeTokenHash !== expectedTokenHash) {
    throw new Error("remote-control websocket challenge token hash mismatch");
  }
  const tokenExpiresAt = remoteControlChallengeField(challenge, "token_expires_at");
  if (tokenExpiresAt == null || tokenExpiresAt <= Math.floor(Date.now() / 1000) || tokenExpiresAt !== session.tokenExpiresAt) {
    throw new Error("remote-control websocket challenge token expiration does not match enrollment");
  }
  const scopes = remoteControlScopeList(remoteControlChallengeField(challenge, "scopes"));
  if (scopes.length !== session.scopes.length || scopes.some((scope, index) => scope !== session.scopes[index])) {
    throw new Error("remote-control websocket challenge scopes do not match enrollment");
  }
  return {
    type: "remoteControlClientConnection",
    nonce: remoteControlChallengeField(challenge, "nonce"),
    audience: remoteControlChallengeField(challenge, "audience"),
    sessionId: remoteControlChallengeField(challenge, "session_id"),
    targetOrigin: target.origin,
    targetPath: target.pathname,
    accountUserId: session.accountUserId,
    clientId: session.clientId,
    tokenSha256Base64url: expectedTokenHash,
    tokenExpiresAt,
    scopes,
  };
}

async function updateWebModeGlobalState(state, patch) {
  const webState = await readWebState(state.args);
  const globalState = webState.globalState && typeof webState.globalState === "object" && !Array.isArray(webState.globalState)
    ? webState.globalState
    : {};
  const nextState = {
    ...webState,
    persistedAtoms: webState.persistedAtoms ?? {},
    sharedObjects: webState.sharedObjects ?? {},
    globalState: {
      ...globalState,
      ...patch,
    },
  };
  await writeWebState(state.args, nextState);
  return nextState.globalState;
}

function electronGlobalStatePath(state) {
  return path.join(state.args.codexHome, ".codex-global-state.json");
}

async function readElectronGlobalState(state) {
  try {
    const parsed = await readJsonFile(electronGlobalStatePath(state));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function writeElectronGlobalState(state, nextState) {
  const statePath = electronGlobalStatePath(state);
  await fs.mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
  const previous = await fs.readFile(statePath).catch((error) => (error.code === "ENOENT" ? null : Promise.reject(error)));
  if (previous) {
    await fs.writeFile(`${statePath}.bak`, previous, { mode: 0o600 });
  }
  await fs.writeFile(statePath, `${JSON.stringify(nextState ?? {}, null, 2)}\n`, { mode: 0o600 });
}

async function updateElectronGlobalState(state, patch) {
  const globalState = await readElectronGlobalState(state);
  const nextState = {
    ...globalState,
    ...patch,
  };
  await writeElectronGlobalState(state, nextState);
  return nextState;
}

async function remoteControlEnrollmentRecord(state) {
  const electronState = await readElectronGlobalState(state);
  const electronEnrollments = electronState?.[REMOTE_CONTROL_ENROLLMENTS_KEY];
  const webState = await readWebState(state.args);
  const enrollments = webState.globalState?.[REMOTE_CONTROL_ENROLLMENTS_KEY];
  const connectionKey = remoteControlConnectionKey();
  for (const candidate of [electronEnrollments, enrollments]) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      continue;
    }
    const record = candidate[connectionKey] ?? candidate.default ?? Object.values(candidate).find((value) => value?.clientId || value?.client_id) ?? null;
    if (record && typeof record === "object") {
      return record;
    }
  }
  return null;
}

async function saveRemoteControlEnrollmentRecord(state, record) {
  const electronState = await readElectronGlobalState(state);
  const webState = await readWebState(state.args);
  const existingElectronEnrollments = electronState?.[REMOTE_CONTROL_ENROLLMENTS_KEY];
  const existingWebEnrollments = webState.globalState?.[REMOTE_CONTROL_ENROLLMENTS_KEY];
  const nextElectronEnrollments = existingElectronEnrollments && typeof existingElectronEnrollments === "object" && !Array.isArray(existingElectronEnrollments)
    ? { ...existingElectronEnrollments }
    : {};
  const nextWebEnrollments = existingWebEnrollments && typeof existingWebEnrollments === "object" && !Array.isArray(existingWebEnrollments)
    ? { ...existingWebEnrollments }
    : {};
  if (record == null) {
    delete nextElectronEnrollments[remoteControlConnectionKey()];
    delete nextWebEnrollments[remoteControlConnectionKey()];
  } else {
    nextElectronEnrollments[remoteControlConnectionKey()] = record;
    nextWebEnrollments[remoteControlConnectionKey()] = record;
  }
  await updateElectronGlobalState(state, {
    [REMOTE_CONTROL_ENROLLMENTS_KEY]: nextElectronEnrollments,
  });
  await updateWebModeGlobalState(state, {
    [REMOTE_CONTROL_ENROLLMENTS_KEY]: nextWebEnrollments,
  });
}

function remoteControlWebSocketAccept(key) {
  return crypto.createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
}

class RemoteControlWebSocket {
  constructor(url, headers = {}) {
    this.url = new URL(url);
    this.headers = headers;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.open = false;
    this.onMessage = () => {};
    this.onClose = () => {};
  }

  async connect() {
    const port = Number(this.url.port || (this.url.protocol === "wss:" ? 443 : 80));
    const host = this.url.hostname;
    const socket =
      this.url.protocol === "wss:"
        ? tls.connect({ host, port, servername: host })
        : net.createConnection({ host, port });
    this.socket = socket;

    await new Promise((resolve, reject) => {
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      const onConnect = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        socket.off("error", onError);
        socket.off(this.url.protocol === "wss:" ? "secureConnect" : "connect", onConnect);
      };
      socket.once("error", onError);
      socket.once(this.url.protocol === "wss:" ? "secureConnect" : "connect", onConnect);
    });

    const key = crypto.randomBytes(16).toString("base64");
    const pathAndSearch = `${this.url.pathname}${this.url.search}`;
    const hostHeader = this.url.port ? `${this.url.hostname}:${this.url.port}` : this.url.hostname;
    const lines = [
      `GET ${pathAndSearch} HTTP/1.1`,
      `Host: ${hostHeader}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${key}`,
      "Sec-WebSocket-Version: 13",
      ...Object.entries(this.headers)
        .filter(([, value]) => value != null)
        .map(([name, value]) => `${name}: ${value}`),
      "",
      "",
    ];
    socket.write(lines.join("\r\n"));

    await this.waitForHandshake(key);
    this.open = true;
    socket.on("data", (chunk) => this.handleData(chunk));
    socket.on("close", () => {
      this.open = false;
      this.onClose();
    });
    socket.on("error", (error) => {
      this.open = false;
      this.onClose(error);
    });
    if (this.buffer.length > 0) {
      const buffered = this.buffer;
      this.buffer = Buffer.alloc(0);
      this.handleData(buffered);
    }
  }

  async waitForHandshake(key) {
    await new Promise((resolve, reject) => {
      let handshake = Buffer.alloc(0);
      const socket = this.socket;
      const timer = setTimeout(() => {
        cleanup();
        socket.destroy();
        reject(new Error("remote-control websocket handshake timed out"));
      }, 10000);
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      const onClose = () => {
        cleanup();
        reject(new Error("remote-control websocket closed before handshake completed"));
      };
      const onData = (chunk) => {
        handshake = Buffer.concat([handshake, chunk]);
        const headerEnd = handshake.indexOf("\r\n\r\n");
        if (headerEnd === -1) {
          return;
        }
        cleanup();
        const head = handshake.subarray(0, headerEnd).toString("latin1");
        const rest = handshake.subarray(headerEnd + 4);
        const [statusLine, ...headerLines] = head.split("\r\n");
        if (!/^HTTP\/1\.[01] 101\b/.test(statusLine)) {
          reject(new Error(`remote-control websocket upgrade failed: ${statusLine}`));
          return;
        }
        const headers = Object.fromEntries(
          headerLines
            .map((line) => line.split(/:\s*/))
            .filter(([name, value]) => name && value)
            .map(([name, ...valueParts]) => [name.toLowerCase(), valueParts.join(": ")]),
        );
        if (headers["sec-websocket-accept"] !== remoteControlWebSocketAccept(key)) {
          reject(new Error("remote-control websocket accept header mismatch"));
          return;
        }
        if (rest.length > 0) {
          this.buffer = Buffer.concat([this.buffer, rest]);
        }
        resolve();
      };
      const cleanup = () => {
        clearTimeout(timer);
        socket.off("error", onError);
        socket.off("close", onClose);
        socket.off("end", onClose);
        socket.off("data", onData);
      };
      socket.on("error", onError);
      socket.on("close", onClose);
      socket.on("end", onClose);
      socket.on("data", onData);
    });
  }

  handleData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const opcode = first & 0x0f;
      let payloadLength = second & 0x7f;
      let offset = 2;
      if (payloadLength === 126) {
        if (this.buffer.length < offset + 2) {
          return;
        }
        payloadLength = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (payloadLength === 127) {
        if (this.buffer.length < offset + 8) {
          return;
        }
        const high = this.buffer.readUInt32BE(offset);
        const low = this.buffer.readUInt32BE(offset + 4);
        if (high !== 0) {
          this.close();
          return;
        }
        payloadLength = low;
        offset += 8;
      }
      const masked = Boolean(second & 0x80);
      const maskOffset = offset;
      if (masked) {
        offset += 4;
      }
      if (this.buffer.length < offset + payloadLength) {
        return;
      }
      let payload = this.buffer.subarray(offset, offset + payloadLength);
      if (masked) {
        const mask = this.buffer.subarray(maskOffset, maskOffset + 4);
        payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
      }
      this.buffer = this.buffer.subarray(offset + payloadLength);

      if (opcode === 0x1) {
        this.onMessage(payload.toString("utf8"));
      } else if (opcode === 0x8) {
        this.close();
      } else if (opcode === 0x9) {
        this.writeFrame(0x0a, payload);
      }
    }
  }

  sendJson(message) {
    this.writeFrame(0x1, Buffer.from(JSON.stringify(message), "utf8"));
  }

  writeFrame(opcode, payload = Buffer.alloc(0)) {
    if (!this.socket || this.socket.destroyed) {
      throw new Error("remote-control websocket is closed");
    }
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    let header;
    if (body.length < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | body.length]);
    } else if (body.length <= 0xffff) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(body.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(body.length, 6);
    }
    const mask = crypto.randomBytes(4);
    const masked = Buffer.from(body.map((byte, index) => byte ^ mask[index % 4]));
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  close() {
    if (!this.socket || this.socket.destroyed) {
      return;
    }
    try {
      this.writeFrame(0x8);
    } catch {
      // Socket may already be closing.
    }
    this.socket.end();
  }
}

async function remoteControlSessionFromEnrollment(state, params = {}) {
  const identity = await remoteControlAccountIdentity(state);
  let record = await remoteControlEnrollmentRecord(state);
  let keyRecord = record?.device_key_id || record?.keyId
    ? await ensureRemoteControlDeviceKey(state, record.device_key_id ?? record.keyId)
    : await ensureRemoteControlDeviceKey(state);

  if (!(record?.client_id ?? record?.clientId)) {
    const stepUpToken = remoteControlStepUpTokenFrom(params);
    if (!stepUpToken) {
      throw Object.assign(
        new Error("Remote control enrollment needs a fresh step-up token; desktop web mode cannot complete browser reauth silently."),
        { remoteControlKind: "auth_required", statusCode: 401 },
      );
    }
    validateRemoteControlStepUpToken(stepUpToken, identity);

    const startResponse = await remoteControlApiFetch(state, "/codex/remote/control/client/enroll/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: {},
    });
    if (!startResponse.ok) {
      throw Object.assign(
        new Error(`Remote control enrollment start failed (${startResponse.status}): ${await remoteControlResponseText(startResponse)}`),
        { statusCode: startResponse.status },
      );
    }
    const start = await remoteControlJsonResponse(startResponse);
    const clientId = start.client_id ?? start.clientId;
    const accountUserId = start.account_user_id ?? start.accountUserId ?? identity.accountUserId;
    const challenge = start.device_key_challenge ?? start.deviceKeyChallenge;
    const finishUrl = new URL(remoteControlApiUrl("/codex/remote/control/client/enroll/finish"));
    const deviceIdentity = remoteControlDeviceIdentityForKey(keyRecord);
    assertRemoteControlEnrollmentChallenge(challenge, {
      clientId,
      accountUserId,
      targetUrl: finishUrl,
      identityHash: remoteControlDeviceIdentityHash(deviceIdentity),
    });
    const deviceKeyProof = signRemoteControlEnrollmentProof(
      keyRecord,
      challenge,
      remoteControlEnrollmentProofPayload(challenge, clientId, accountUserId, deviceIdentity),
    );
    const finishResponse = await remoteControlApiFetch(state, "/codex/remote/control/client/enroll/finish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: {
        client_id: clientId,
        step_up_token: stepUpToken,
        device_identity: deviceIdentity,
        device_key_proof: deviceKeyProof,
      },
    });
    if (!finishResponse.ok) {
      throw Object.assign(
        new Error(`Remote control enrollment finish failed (${finishResponse.status}): ${await remoteControlResponseText(finishResponse)}`),
        { statusCode: finishResponse.status },
      );
    }
    const finish = await remoteControlJsonResponse(finishResponse);
    record = {
      connection_key: remoteControlConnectionKey(),
      client_id: finish.client_id ?? clientId,
      account_user_id: finish.account_user_id ?? accountUserId,
      device_key_id: keyRecord.key_id ?? keyRecord.keyId,
      clientId: finish.client_id ?? clientId,
      accountUserId: finish.account_user_id ?? accountUserId,
      keyId: keyRecord.key_id ?? keyRecord.keyId,
      algorithm: keyRecord.algorithm,
      protectionClass: keyRecord.protection_class ?? keyRecord.protectionClass,
      publicKeySpkiDerBase64: keyRecord.public_key_spki_der_base64 ?? keyRecord.publicKeySpkiDerBase64,
      created_at: new Date().toISOString(),
    };
    await saveRemoteControlEnrollmentRecord(state, record);
    return remoteControlSessionFromTokenResponse(record, keyRecord, finish);
  }

  const clientId = record.client_id ?? record.clientId;
  const accountUserId = record.account_user_id ?? record.accountUserId ?? identity.accountUserId;
  const startResponse = await remoteControlApiFetch(state, "/codex/remote/control/client/refresh/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: { client_id: clientId },
  });
  if (startResponse.status === 404) {
    await saveRemoteControlEnrollmentRecord(state, null);
    return await remoteControlSessionFromEnrollment(state, params);
  }
  if (!startResponse.ok) {
    throw Object.assign(
      new Error(`Remote control session refresh start failed (${startResponse.status}): ${await remoteControlResponseText(startResponse)}`),
      { statusCode: startResponse.status },
    );
  }
  const start = await remoteControlJsonResponse(startResponse);
  if ((start.client_id ?? start.clientId) !== clientId || (start.account_user_id ?? start.accountUserId ?? accountUserId) !== accountUserId) {
    throw new Error("remote-control refresh challenge does not match local enrollment");
  }
  const challenge = start.device_key_challenge ?? start.deviceKeyChallenge;
  const finishUrl = new URL(remoteControlApiUrl("/codex/remote/control/client/refresh/finish"));
  const identityHash = remoteControlDeviceIdentityHash(remoteControlDeviceIdentityForKey(keyRecord));
  assertRemoteControlEnrollmentChallenge(challenge, {
    clientId,
    accountUserId,
    targetUrl: finishUrl,
    requireDeviceIdentityHash: true,
    identityHash,
  });
  const deviceKeyProof = signRemoteControlEnrollmentProof(keyRecord, challenge, {
    type: "remoteControlClientEnrollment",
    nonce: remoteControlChallengeField(challenge, "nonce"),
    audience: remoteControlChallengeField(challenge, "audience"),
    challengeId: remoteControlChallengeField(challenge, "challenge_id"),
    targetOrigin: remoteControlChallengeField(challenge, "target_origin"),
    targetPath: remoteControlChallengeField(challenge, "target_path"),
    accountUserId,
    clientId,
    deviceIdentitySha256Base64url: identityHash,
    challengeExpiresAt: remoteControlChallengeField(challenge, "challenge_expires_at"),
  });
  const finishResponse = await remoteControlApiFetch(state, "/codex/remote/control/client/refresh/finish", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: {
      client_id: clientId,
      device_key_proof: deviceKeyProof,
    },
  });
  if (!finishResponse.ok) {
    throw Object.assign(
      new Error(`Remote control session refresh finish failed (${finishResponse.status}): ${await remoteControlResponseText(finishResponse)}`),
      { statusCode: finishResponse.status },
    );
  }
  return remoteControlSessionFromTokenResponse(record, keyRecord, await remoteControlJsonResponse(finishResponse));
}

function remoteControlSessionFromTokenResponse(record, keyRecord, body) {
  const token = body.remote_control_token ?? body.remoteControlToken;
  const expiresAt = body.expires_at ?? body.expiresAt;
  const tokenExpiresAt = remoteControlTimestampSeconds(expiresAt);
  const scopes = remoteControlScopeList(body.scopes ?? body.scope);
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("remote-control session response did not include a token");
  }
  if (!scopes.includes(REMOTE_CONTROL_REQUIRED_SCOPE)) {
    throw new Error(`remote-control session response did not include ${REMOTE_CONTROL_REQUIRED_SCOPE}`);
  }
  if (tokenExpiresAt == null || tokenExpiresAt <= Math.floor(Date.now() / 1000)) {
    throw new Error("remote-control session token is expired");
  }
  return {
    clientId: body.client_id ?? body.clientId ?? record.client_id ?? record.clientId,
    accountUserId: body.account_user_id ?? body.accountUserId ?? record.account_user_id ?? record.accountUserId,
    remoteControlToken: token,
    expiresAt,
    tokenExpiresAt,
    scopes,
    keyRecord,
    requiresDeviceKeyProof: true,
  };
}

async function remoteControlClientSession(state, params = {}) {
  const existing = state.remoteControl.session;
  if (existing?.remoteControlToken && existing.tokenExpiresAt > Math.floor(Date.now() / 1000) + 60) {
    return existing;
  }
  const session = await remoteControlSessionFromEnrollment(state, params);
  state.remoteControl.session = session;
  state.remoteControl.last_error = null;
  return session;
}

class RemoteControlAppServerConnection {
  constructor(state, connection) {
    this.state = state;
    this.hostId = connection.hostId;
    this.envId = connection.envId;
    this.displayName = connection.displayName;
    this.status = "disconnected";
    this.error = null;
    this.ws = null;
    this.streamId = null;
    this.nextSeqId = 1;
    this.pending = new Map();
    this.initialized = false;
    this.initializeResult = null;
    this.opening = null;
    this.serverMessageAssemblies = new Map();
  }

  async ensureOpen(params = {}) {
    if (this.ws?.open) {
      return;
    }
    this.opening ??= this.openRemoteControlSocket(params).finally(() => {
      this.opening = null;
    });
    await this.opening;
  }

  async openRemoteControlSocket(params = {}) {
    this.status = "connecting";
    const session = await remoteControlClientSession(this.state, params);
    const websocketUrl = remoteControlWebSocketUrl();
    const authHeaders = await remoteControlAuthHeaders(this.state);
    const headers = {
      ...authHeaders,
      "x-codex-client-id": session.clientId,
      "x-codex-protocol-version": REMOTE_CONTROL_PROTOCOL_VERSION,
      "x-codex-client-session-token": `Bearer ${session.remoteControlToken}`,
    };
    const ws = new RemoteControlWebSocket(websocketUrl, headers);
    this.ws = ws;
    let challengeResolved = false;
    const challengeReady = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        challengeResolved = true;
        reject(new Error("remote-control device-key challenge timed out"));
      }, session.requiresDeviceKeyProof ? 10000 : 500);
      ws.onMessage = (raw) => {
        void (async () => {
          try {
            const envelope = JSON.parse(raw);
            if (envelope?.type === "device_key_challenge") {
              const proof = signRemoteControlWebSocketProof(
                session.keyRecord,
                remoteControlConnectionProofPayload(envelope, session, websocketUrl),
              );
              ws.sendJson(proof);
              if (!challengeResolved) {
                clearTimeout(timer);
                challengeResolved = true;
                resolve();
              }
              return;
            }
            if (!challengeResolved && session.requiresDeviceKeyProof) {
              clearTimeout(timer);
              challengeResolved = true;
              reject(new Error("remote-control websocket sent data before device-key challenge"));
              return;
            }
            this.handleEnvelope(envelope);
          } catch (error) {
            if (!challengeResolved) {
              clearTimeout(timer);
              challengeResolved = true;
              reject(error);
            } else {
              this.rejectAll(error);
            }
          }
        })();
      };
      ws.onClose = (error) => {
        this.status = "disconnected";
        this.error = error?.message ?? "remote-control websocket closed";
        this.rejectAll(new Error(this.error));
      };
    });
    await ws.connect();
    await challengeReady;
    this.status = "connected";
    this.error = null;
  }

  handleEnvelope(envelope) {
    if (envelope?.type === "server_message") {
      this.handleServerMessage(envelope.message);
    } else if (envelope?.type === "server_message_chunk") {
      const reassembled = this.reassembleServerMessage(envelope);
      if (reassembled) {
        this.handleServerMessage(reassembled.message);
      }
    } else if (envelope?.type === "error") {
      const pending = this.pending.values().next().value;
      pending?.reject(new Error(envelope.message ?? envelope.error ?? "remote-control websocket error"));
    }
  }

  reassembleServerMessage(envelope) {
    const segmentId = envelope.segment_id ?? 0;
    const segmentCount = envelope.segment_count ?? 1;
    const messageSizeBytes = envelope.message_size_bytes;
    if (
      segmentCount <= 1 ||
      segmentId < 0 ||
      segmentId >= segmentCount ||
      segmentCount > Math.ceil(REMOTE_CONTROL_MAX_REASSEMBLED_BYTES / REMOTE_CONTROL_SEGMENT_MESSAGE_BYTES) ||
      messageSizeBytes <= 0 ||
      messageSizeBytes > REMOTE_CONTROL_MAX_REASSEMBLED_BYTES ||
      typeof envelope.message_chunk_base64 !== "string"
    ) {
      this.rejectAll(new Error("remote-control server message chunk is invalid"));
      return null;
    }
    const key = `${envelope.env_id}:${envelope.stream_id}:${envelope.seq_id}`;
    let assembly = this.serverMessageAssemblies.get(key);
    if (!assembly) {
      assembly = {
        first: envelope,
        segmentCount,
        chunks: Array(segmentCount).fill(null),
      };
      this.serverMessageAssemblies.set(key, assembly);
    }
    if (
      assembly.segmentCount !== segmentCount ||
      assembly.first.env_id !== envelope.env_id ||
      assembly.first.message_size_bytes !== messageSizeBytes
    ) {
      this.serverMessageAssemblies.delete(key);
      this.rejectAll(new Error("remote-control server message chunk metadata changed mid-message"));
      return null;
    }
    assembly.chunks[segmentId] = envelope.message_chunk_base64;
    if (assembly.chunks.some((chunk) => chunk == null)) {
      return null;
    }
    this.serverMessageAssemblies.delete(key);
    const messageBytes = Buffer.concat(assembly.chunks.map((chunk) => Buffer.from(chunk, "base64")));
    if (messageBytes.length !== messageSizeBytes) {
      this.rejectAll(new Error("remote-control server message chunk size mismatch"));
      return null;
    }
    let message;
    try {
      message = JSON.parse(messageBytes.toString("utf8"));
    } catch (error) {
      this.rejectAll(error);
      return null;
    }
    return {
      type: "server_message",
      client_id: envelope.client_id,
      seq_id: envelope.seq_id,
      stream_id: envelope.stream_id,
      env_id: envelope.env_id,
      cursor: envelope.cursor,
      message,
    };
  }

  handleServerMessage(message) {
    if (message?.id == null || !this.pending.has(message.id)) {
      publishAppServerNotification(this.state, message);
      return;
    }
    const pending = this.pending.get(message.id);
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message ?? "remote app-server request failed"));
    } else {
      pending.resolve(message.result);
    }
  }

  async initialize() {
    if (this.initialized) {
      return this.initializeResult;
    }
    this.streamId = crypto.randomUUID();
    const result = await this.sendRawRpc(
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
    );
    this.initialized = true;
    this.initializeResult = result;
    this.sendNotification({ method: "initialized" });
    return result;
  }

  async request(method, params = {}, timeoutMs = 30000) {
    await this.ensureOpen();
    if (!this.initialized && method !== "initialize") {
      await this.initialize();
    }
    return await this.sendRawRpc(method, params, timeoutMs);
  }

  async sendRawRpc(method, params = {}, timeoutMs = 30000) {
    await this.ensureOpen();
    const id = this.state.nextRpcId++;
    const response = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`remote app-server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
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
    this.sendClientMessage({ jsonrpc: "2.0", id, method, params });
    return await response;
  }

  sendNotification(message) {
    if (this.ws?.open) {
      this.sendClientMessage(message);
    }
  }

  sendClientMessage(message) {
    if (!this.streamId) {
      this.streamId = crypto.randomUUID();
    }
    const envelope = {
      type: "client_message",
      client_id: this.state.remoteControl.session?.clientId,
      seq_id: this.nextSeqId++,
      stream_id: this.streamId,
      env_id: this.envId,
      skip_history: false,
      message,
    };
    for (const segment of remoteControlSegmentEnvelope(envelope)) {
      this.ws.sendJson(segment);
    }
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
    this.pending.clear();
  }

  close() {
    this.rejectAll(new Error("remote-control connection closed"));
    this.serverMessageAssemblies.clear();
    this.ws?.close();
    this.ws = null;
    this.status = "disconnected";
  }
}

function remoteControlEnvironmentPath(envId) {
  return `/codex/remote/control/environments/${encodeURIComponent(envId)}`;
}

function remoteControlEnvironmentsPath(cursor = null) {
  const params = new URLSearchParams({ limit: "100" });
  if (cursor != null) {
    params.set("cursor", cursor);
  }
  return `/codex/remote/control/environments?${params.toString()}`;
}

function remoteControlConnectionFromEnvironment(environment) {
  const envId = environment?.env_id ?? environment?.environment_id ?? environment?.id;
  const displayName = [environment?.display_name, environment?.displayName, environment?.name, environment?.host_name, environment?.hostName, envId]
    .find((value) => typeof value === "string" && value.trim().length > 0)
    ?.trim();
  const hostName = [environment?.host_name, environment?.hostName, environment?.name, environment?.display_name, environment?.displayName, displayName]
    .find((value) => typeof value === "string" && value.trim().length > 0)
    ?.trim();
  return {
    hostId: `remote-control:${envId}`,
    displayName: displayName || String(envId),
    hostName: hostName || displayName || String(envId),
    autoConnect: false,
    source: "remote-control",
    envId,
    environmentKind: environment?.kind ?? null,
    clientType: environment?.client_type ?? "CODEX_UNKNOWN",
    online: Boolean(environment?.online),
    busy: Boolean(environment?.busy),
    os: environment?.os ?? null,
    arch: environment?.arch ?? null,
    appServerVersion: environment?.app_server_version ?? null,
    installationId: environment?.installation_id ?? null,
    lastSeenAt: environment?.last_seen_at ?? null,
  };
}

async function fetchRemoteControlEnvironments(state, cursor = null) {
  const response = await remoteControlApiFetch(state, remoteControlEnvironmentsPath(cursor));
  if (response.status === 404) {
    throw Object.assign(new Error("remote control feature unavailable"), { remoteControlKind: "feature_unavailable" });
  }
  if (response.status === 403) {
    throw Object.assign(new Error(await remoteControlResponseText(response)), { remoteControlKind: "access_required" });
  }
  if (response.status === 401) {
    throw Object.assign(new Error("remote control auth required"), { remoteControlKind: "auth_required" });
  }
  if (!response.ok) {
    throw new Error(`Remote control environments request failed (${response.status}): ${await remoteControlResponseText(response)}`);
  }
  const body = await remoteControlJsonResponse(response);
  const items = Array.isArray(body.items) ? body.items.map(remoteControlConnectionFromEnvironment) : [];
  return body.cursor == null ? items : items.concat(await fetchRemoteControlEnvironments(state, body.cursor));
}

async function writeRemoteControlUnavailableState(state, kind) {
  const stateByKind = {
    feature_unavailable: {
      available: false,
      accessRequired: false,
      authRequired: false,
      clientAuthorized: false,
    },
    access_required: {
      available: false,
      accessRequired: true,
      authRequired: false,
      clientAuthorized: false,
    },
    auth_required: {
      available: true,
      accessRequired: false,
      authRequired: true,
      clientAuthorized: false,
    },
  };
  return await updateWebModeSharedObjects(state, {
    local_remote_control_client_id: null,
    remote_control_connections: [],
    remote_control_connections_state: stateByKind[kind] ?? defaultRemoteControlConnectionsState(true, false),
  });
}

function defaultRemoteControlConnectionsState(enabled = true, clientAuthorized = false) {
  return {
    available: Boolean(enabled),
    accessRequired: false,
    authRequired: false,
    clientAuthorized: Boolean(clientAuthorized),
  };
}

function remoteControlSharedObjectDefaults(state, enabled = true) {
  const clientId = stableWebModeId("web-client", `${state.args.profile}:${state.args.codexHome}`);
  const environmentId = stableWebModeId("web-env", state.args.workspace);
  const installationId = stableWebModeId("web-install", `${state.args.appDir}:${state.args.codexHome}`);
  return {
    local_app_server_feature_enablement: {
      remote_control: Boolean(enabled),
    },
    local_remote_control_client_id: clientId,
    local_remote_control_environment_id: environmentId,
    local_remote_control_installation_id: installationId,
    remote_control_connections_state: defaultRemoteControlConnectionsState(enabled, false),
    remote_control_connections: [],
    remote_connections: [],
  };
}

async function updateWebModeSharedObjects(state, patch) {
  const webState = await readWebState(state.args);
  const sharedObjects =
    webState.sharedObjects && typeof webState.sharedObjects === "object" && !Array.isArray(webState.sharedObjects)
      ? webState.sharedObjects
      : {};
  const nextSharedObjects = {
    ...sharedObjects,
    ...patch,
    local_app_server_feature_enablement: {
      ...(sharedObjects.local_app_server_feature_enablement ?? {}),
      ...(patch.local_app_server_feature_enablement ?? {}),
    },
  };
  const nextState = {
    ...webState,
    persistedAtoms: webState.persistedAtoms ?? {},
    globalState: webState.globalState ?? {},
    sharedObjects: nextSharedObjects,
  };
  await writeWebState(state.args, nextState);
  return nextSharedObjects;
}

async function ensureRemoteControlSharedObjects(state, { enabled = true } = {}) {
  const webState = await readWebState(state.args);
  const sharedObjects =
    webState.sharedObjects && typeof webState.sharedObjects === "object" && !Array.isArray(webState.sharedObjects)
      ? webState.sharedObjects
      : {};
  const existingEnablement = sharedObjects.local_app_server_feature_enablement?.remote_control;
  const effectiveEnabled = existingEnablement == null ? Boolean(enabled) : Boolean(existingEnablement);
  return await updateWebModeSharedObjects(state, {
    ...remoteControlSharedObjectDefaults(state, effectiveEnabled),
    ...Object.fromEntries(
      [
        "local_remote_control_client_id",
        "local_remote_control_environment_id",
        "local_remote_control_installation_id",
        "remote_control_connections",
        "remote_connections",
      ]
        .filter((key) => sharedObjects[key] != null)
        .map((key) => [key, sharedObjects[key]]),
    ),
    remote_control_connections_state:
      sharedObjects.remote_control_connections_state && typeof sharedObjects.remote_control_connections_state === "object"
        ? {
            ...defaultRemoteControlConnectionsState(effectiveEnabled, false),
            ...sharedObjects.remote_control_connections_state,
            available: effectiveEnabled && sharedObjects.remote_control_connections_state.available !== false,
          }
        : defaultRemoteControlConnectionsState(effectiveEnabled, false),
    local_app_server_feature_enablement: {
      ...(sharedObjects.local_app_server_feature_enablement ?? {}),
      remote_control: effectiveEnabled,
    },
  });
}

function remoteControlRefreshResult(sharedObjects) {
  const remoteControlConnections = Array.isArray(sharedObjects.remote_control_connections)
    ? sharedObjects.remote_control_connections
    : [];
  const remoteConnections = Array.isArray(sharedObjects.remote_connections) ? sharedObjects.remote_connections : [];
  return {
    remoteControlConnections,
    connections: remoteControlConnections,
    state: sharedObjects.remote_control_connections_state ?? defaultRemoteControlConnectionsState(true, false),
    clientId: sharedObjects.local_remote_control_client_id ?? null,
    environmentId: sharedObjects.local_remote_control_environment_id ?? null,
    installationId: sharedObjects.local_remote_control_installation_id ?? null,
    sharedObjects: {
      local_app_server_feature_enablement: sharedObjects.local_app_server_feature_enablement ?? { remote_control: true },
      local_remote_control_client_id: sharedObjects.local_remote_control_client_id ?? null,
      local_remote_control_environment_id: sharedObjects.local_remote_control_environment_id ?? null,
      local_remote_control_installation_id: sharedObjects.local_remote_control_installation_id ?? null,
      remote_control_connections_state: sharedObjects.remote_control_connections_state ?? defaultRemoteControlConnectionsState(true, false),
      remote_control_connections: remoteControlConnections,
      remote_connections: remoteConnections,
    },
  };
}

async function refreshRemoteControlConnections(state) {
  const sharedObjects = await ensureRemoteControlSharedObjects(state);
  if (sharedObjects.local_app_server_feature_enablement?.remote_control === false) {
    const nextSharedObjects = await updateWebModeSharedObjects(state, {
      remote_control_connections: [],
      remote_control_connections_state: defaultRemoteControlConnectionsState(false, false),
    });
    return remoteControlRefreshResult(nextSharedObjects);
  }

  try {
    const remoteControlConnections = await fetchRemoteControlEnvironments(state);
    const nextSharedObjects = await updateWebModeSharedObjects(state, {
      remote_control_connections: remoteControlConnections,
      remote_control_connections_state: {
        available: true,
        accessRequired: false,
        authRequired: false,
        clientAuthorized: sharedObjects.remote_control_connections_state?.clientAuthorized === true,
      },
    });
    return remoteControlRefreshResult(nextSharedObjects);
  } catch (error) {
    if (error?.remoteControlKind) {
      return remoteControlRefreshResult(await writeRemoteControlUnavailableState(state, error.remoteControlKind));
    }
    const nextSharedObjects = await updateWebModeSharedObjects(state, {
      local_remote_control_client_id: null,
      remote_control_connections: [],
      remote_control_connections_state: defaultRemoteControlConnectionsState(true, false),
    });
    appendServeLog(state, "remote_control_refresh_failed", { error: error instanceof Error ? error.message : String(error) }, "warn");
    return {
      ...remoteControlRefreshResult(nextSharedObjects),
      warning: error instanceof Error ? error.message : String(error),
    };
  }
}

async function setRemoteControlConnectionsEnabled(state, enabled) {
  const nextEnabled = Boolean(enabled);
  if (!nextEnabled) {
    await stopRemoteControlConnections(state);
  }
  const existingSharedObjects = await ensureRemoteControlSharedObjects(state, { enabled: nextEnabled });
  const sharedObjects = await updateWebModeSharedObjects(state, {
    remote_control_connections_state: defaultRemoteControlConnectionsState(nextEnabled, false),
    ...(nextEnabled ? {} : { remote_control_connections: [] }),
    local_app_server_feature_enablement: {
      ...(existingSharedObjects.local_app_server_feature_enablement ?? {}),
      remote_control: nextEnabled,
    },
  });
  return nextEnabled
    ? { enabled: true, ...(await refreshRemoteControlConnections(state)) }
    : { enabled: false, ...remoteControlRefreshResult(sharedObjects) };
}

async function updateRemoteControlConnection(state, updater) {
  const sharedObjects = await ensureRemoteControlSharedObjects(state);
  const connections = Array.isArray(sharedObjects.remote_control_connections)
    ? updater(sharedObjects.remote_control_connections)
    : updater([]);
  const nextSharedObjects = await updateWebModeSharedObjects(state, {
    remote_control_connections: connections,
  });
  return remoteControlRefreshResult(nextSharedObjects);
}

function connectionHostId(params = {}) {
  return params.hostId ?? params.host_id ?? params.connection?.hostId ?? params.connection?.host_id ?? null;
}

function isRemoteControlHostId(hostId) {
  return typeof hostId === "string" && hostId.startsWith("remote-control:");
}

async function remoteControlConnectionForHostId(state, hostId) {
  let sharedObjects = await ensureRemoteControlSharedObjects(state);
  let connections = Array.isArray(sharedObjects.remote_control_connections) ? sharedObjects.remote_control_connections : [];
  let connection = connections.find((candidate) => candidate?.hostId === hostId);
  if (!connection) {
    const refresh = await refreshRemoteControlConnections(state);
    connections = refresh.remoteControlConnections;
    connection = connections.find((candidate) => candidate?.hostId === hostId);
  }
  if (!connection) {
    throw Object.assign(new Error(`remote-control host not found: ${hostId}`), { statusCode: 404 });
  }
  if (!connection.envId) {
    throw Object.assign(new Error(`remote-control host has no environment id: ${hostId}`), { statusCode: 400 });
  }
  return connection;
}

async function remoteControlAppServerConnection(state, hostId, params = {}) {
  const connection = await remoteControlConnectionForHostId(state, hostId);
  let appServerConnection = state.remoteControl.connections.get(hostId);
  if (!appServerConnection) {
    appServerConnection = new RemoteControlAppServerConnection(state, connection);
    state.remoteControl.connections.set(hostId, appServerConnection);
  }
  await appServerConnection.ensureOpen(params);
  return appServerConnection;
}

async function remoteControlAppServerRequest(state, hostId, method, params = {}, timeoutMs = 30000) {
  const connection = await remoteControlAppServerConnection(state, hostId);
  return await connection.request(method, params, timeoutMs);
}

function appServerRpcHostId(params = {}) {
  return connectionHostId(params);
}

function appServerRpcParams(params = {}) {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return params;
  }
  const { hostId, host_id, connection, ...rest } = params;
  return rest;
}

async function routeAppServerRpc(state, method, params = {}, timeoutMs = 30000) {
  const hostId = appServerRpcHostId(params);
  const routedParams = appServerRpcParams(params);
  if (isRemoteControlHostId(hostId)) {
    return await remoteControlAppServerRequest(state, hostId, method, routedParams, timeoutMs);
  }
  return await sendAppServerRpc(state, method, routedParams, timeoutMs);
}

function remotePathJoin(directoryPath, fileName) {
  const base = String(directoryPath || "/");
  const separator = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  return `${base.replace(/[\\/]+$/, "")}${separator}${fileName}`;
}

async function stopRemoteControlConnections(state) {
  await Promise.allSettled(
    [...state.remoteControl.connections.values()].map(async (connection) => {
      connection.close();
    }),
  );
  state.remoteControl.connections.clear();
}

function normalizeRemoteConnectionState(stateValue = "disconnected", error = null) {
  return {
    state: stateValue,
    status: stateValue,
    error,
  };
}

function unsupportedRemoteConnectionResult(reason) {
  return {
    ok: false,
    supported: false,
    state: "error",
    status: "error",
    reason,
    error: {
      code: "connection-failed",
      message: reason,
    },
  };
}

async function setRemoteConnectionAutoConnect(state, params = {}) {
  const hostId = connectionHostId(params);
  const autoConnect = Boolean(params.autoConnect ?? params.auto_connect ?? params.enabled);
  const sharedObjects = await ensureRemoteControlSharedObjects(state);
  const remoteConnections = Array.isArray(sharedObjects.remote_connections)
    ? sharedObjects.remote_connections.map((connection) =>
        connection?.hostId === hostId ? { ...connection, autoConnect } : connection,
      )
    : [];
  const remoteControlConnections = Array.isArray(sharedObjects.remote_control_connections)
    ? sharedObjects.remote_control_connections.map((connection) =>
        connection?.hostId === hostId ? { ...connection, autoConnect } : connection,
      )
    : [];
  const nextSharedObjects = await updateWebModeSharedObjects(state, {
    remote_connections: remoteConnections,
    remote_control_connections: remoteControlConnections,
  });
  let connectionState = "disconnected";
  let connectionError = null;
  if (isRemoteControlHostId(hostId)) {
    if (autoConnect) {
      try {
        const connection = await remoteControlAppServerConnection(state, hostId, params);
        await connection.initialize();
        connectionState = "connected";
      } catch (error) {
        connectionState = "error";
        connectionError = {
          code: "connection-failed",
          message: error instanceof Error ? error.message : String(error),
        };
        state.remoteControl.last_error = connectionError.message;
      }
    } else {
      state.remoteControl.connections.get(hostId)?.close();
      state.remoteControl.connections.delete(hostId);
    }
  }
  return {
    hostId,
    autoConnect,
    remoteConnections,
    remoteControlConnections,
    connections: [...remoteConnections, ...remoteControlConnections],
    state: connectionState,
    error: connectionError,
    sharedObjects: {
      remote_connections: nextSharedObjects.remote_connections ?? [],
      remote_control_connections: nextSharedObjects.remote_control_connections ?? [],
    },
  };
}

async function localDirectoryEntries(directoryPath, { directoriesOnly = false } = {}) {
  const resolved = path.resolve(String(directoryPath || process.cwd()));
  const entries = await fs.readdir(resolved, { withFileTypes: true });
  return {
    directoryPath: resolved,
    entries: entries
      .filter((entry) => !directoriesOnly || entry.isDirectory())
      .map((entry) => ({
        type: entry.isDirectory() ? "directory" : "file",
        name: entry.name,
        path: path.join(resolved, entry.name),
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
      }))
      .sort((left, right) => {
        if (left.isDirectory !== right.isDirectory) {
          return left.isDirectory ? -1 : 1;
        }
        return left.name.localeCompare(right.name);
      }),
  };
}

async function remoteWorkspaceDirectoryEntries(state, params = {}) {
  const hostId = connectionHostId(params);
  const directoryPath = params.directoryPath ?? params.path ?? state.args.workspace;
  if (!hostId || hostId === "local") {
    return await localDirectoryEntries(directoryPath, { directoriesOnly: Boolean(params.directoriesOnly ?? params.directories_only) });
  }
  if (!isRemoteControlHostId(hostId)) {
    throw Object.assign(new Error(`unsupported remote host id: ${hostId}`), { statusCode: 400 });
  }
  const remoteDirectory = String(directoryPath || "/");
  const metadata = await remoteControlAppServerRequest(state, hostId, "fs/getMetadata", { path: remoteDirectory });
  if (metadata?.isDirectory === false) {
    throw Object.assign(new Error(`remote path is not a directory: ${remoteDirectory}`), { statusCode: 400 });
  }
  const result = await remoteControlAppServerRequest(state, hostId, "fs/readDirectory", { path: remoteDirectory });
  const entries = Array.isArray(result?.entries) ? result.entries : [];
  return {
    directoryPath: remoteDirectory,
    entries: entries
      .filter((entry) => !Boolean(params.directoriesOnly ?? params.directories_only) || entry?.isDirectory)
      .map((entry) => ({
        type: entry?.isDirectory ? "directory" : "file",
        name: entry.fileName ?? entry.name,
        path: remotePathJoin(remoteDirectory, entry.fileName ?? entry.name),
        isDirectory: Boolean(entry?.isDirectory),
        isFile: Boolean(entry?.isFile),
      }))
      .sort((left, right) => {
        if (left.isDirectory !== right.isDirectory) {
          return left.isDirectory ? -1 : 1;
        }
        return left.name.localeCompare(right.name);
      }),
  };
}

async function handleDesktopHostRequest(state, method, params = {}) {
  switch (method) {
    case "app-server-connection-state": {
      const hostId = connectionHostId(params);
      if (hostId === "local" || !hostId) {
        return normalizeRemoteConnectionState("connected");
      }
      if (isRemoteControlHostId(hostId)) {
        const connection = state.remoteControl.connections.get(hostId);
        return normalizeRemoteConnectionState(connection?.status ?? "disconnected", connection?.error ? { code: "connection-failed", message: connection.error } : null);
      }
      return normalizeRemoteConnectionState("error", {
        code: "connection-failed",
        message: `unsupported remote host id: ${hostId}`,
      });
    }
    case "refresh-remote-control-connections":
      return await refreshRemoteControlConnections(state);
    case "set-remote-control-connections-enabled":
      return await setRemoteControlConnectionsEnabled(state, params.enabled ?? params.enablement);
    case "set-remote-connection-auto-connect":
      return await setRemoteConnectionAutoConnect(state, params);
    case "remote-workspace-directory-entries":
      return await remoteWorkspaceDirectoryEntries(state, params);
    case "install-remote-codex":
      return unsupportedRemoteConnectionResult("Installing Codex on a remote host from web mode needs a remote-control websocket controller.");
    case "start-remote-chatgpt-login-port-forward":
      throw Object.assign(
        new Error("Remote ChatGPT login port forwarding is not available until web mode owns the remote-control websocket controller."),
        { statusCode: 501 },
      );
    case "stop-remote-chatgpt-login-port-forward":
      return { ok: true, stopped: false, reason: "no web-mode remote login port forward was active" };
    case "authorize-remote-control-connections": {
      try {
        const session = await remoteControlClientSession(state, params);
        const sharedObjects = await ensureRemoteControlSharedObjects(state);
        const nextSharedObjects = await updateWebModeSharedObjects(state, {
          local_remote_control_client_id: session.clientId,
          remote_control_connections_state: {
            ...defaultRemoteControlConnectionsState(true, true),
            ...(sharedObjects.remote_control_connections_state ?? {}),
            available: true,
            authRequired: false,
            clientAuthorized: true,
          },
        });
        return {
          authorized: true,
          status: "authorized",
          ...remoteControlRefreshResult(nextSharedObjects),
        };
      } catch (error) {
        const sharedObjects = await ensureRemoteControlSharedObjects(state);
        const nextSharedObjects = await updateWebModeSharedObjects(state, {
          remote_control_connections_state: {
            ...defaultRemoteControlConnectionsState(true, false),
            ...(sharedObjects.remote_control_connections_state ?? {}),
            available: true,
            authRequired: true,
            clientAuthorized: false,
          },
        });
        return {
          authorized: false,
          status: "auth_required",
          reason: error instanceof Error ? error.message : String(error),
          ...remoteControlRefreshResult(nextSharedObjects),
        };
      }
    }
    case "rename-remote-control-environment": {
      const envId = params.envId ?? params.environmentId;
      const name = typeof params.name === "string" ? params.name.trim() : "";
      if (!envId) {
        throw Object.assign(new Error("missing remote control environment id"), { statusCode: 400 });
      }
      if (!name) {
        throw Object.assign(new Error("Remote control display name cannot be empty."), { statusCode: 400 });
      }
      const response = await remoteControlApiFetch(state, remoteControlEnvironmentPath(envId), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: { name },
      });
      if (!response.ok) {
        throw Object.assign(
          new Error(`Remote control rename failed (${response.status}): ${await remoteControlResponseText(response)}`),
          { statusCode: response.status },
        );
      }
      const updatedConnection = remoteControlConnectionFromEnvironment(await remoteControlJsonResponse(response));
      const result = await updateRemoteControlConnection(state, (connections) =>
        connections.map((connection) => (connection?.envId === envId ? { ...updatedConnection, autoConnect: connection.autoConnect === true } : connection)),
      );
      return {
        ...result,
        remoteControlConnection: result.remoteControlConnections.find((connection) => connection.envId === envId) ?? updatedConnection,
      };
    }
    case "delete-remote-control-environment": {
      const envId = params.envId ?? params.environmentId;
      if (!envId) {
        throw Object.assign(new Error("missing remote control environment id"), { statusCode: 400 });
      }
      const sharedObjects = await ensureRemoteControlSharedObjects(state);
      const existing = Array.isArray(sharedObjects.remote_control_connections)
        ? sharedObjects.remote_control_connections.find((connection) => connection?.envId === envId)
        : null;
      if (existing?.online) {
        throw Object.assign(new Error("Only offline remote control environments can be deleted."), { statusCode: 400 });
      }
      const response = await remoteControlApiFetch(state, remoteControlEnvironmentPath(envId), {
        method: "DELETE",
      });
      if (!response.ok) {
        throw Object.assign(
          new Error(`Remote control delete failed (${response.status}): ${await remoteControlResponseText(response)}`),
          { statusCode: response.status },
        );
      }
      return await updateRemoteControlConnection(state, (connections) =>
        connections.filter((connection) => connection?.envId !== envId),
      );
    }
    case "refresh-remote-connections": {
      const sharedObjects = await ensureRemoteControlSharedObjects(state);
      const remoteConnections = Array.isArray(sharedObjects.remote_connections) ? sharedObjects.remote_connections : [];
      return {
        remoteConnections,
        connections: remoteConnections,
        sharedObjects: {
          remote_connections: remoteConnections,
        },
      };
    }
    case "discover-remote-ssh-connections":
      return { discoveredRemoteConnections: [], connections: [] };
    case "save-codex-managed-remote-ssh-connections": {
      const connections = Array.isArray(params.remoteConnections)
        ? params.remoteConnections
        : Array.isArray(params.connections)
          ? params.connections
          : [];
      const sharedObjects = await updateWebModeSharedObjects(state, { remote_connections: connections });
      const remoteConnections = Array.isArray(sharedObjects.remote_connections) ? sharedObjects.remote_connections : [];
      return {
        remoteConnections,
        connections: remoteConnections,
        sharedObjects: {
          remote_connections: remoteConnections,
        },
      };
    }
    default:
      throw Object.assign(new Error(`unsupported desktop host method: ${method}`), { statusCode: 404 });
  }
}

async function webModeRemoteControlClientsResponse(state) {
  const sharedObjects = await ensureRemoteControlSharedObjects(state);
  return {
    status: sharedObjects.remote_control_connections_state?.available === false ? "unavailable" : "available",
    clients: Array.isArray(sharedObjects.remote_control_connections) ? sharedObjects.remote_control_connections : [],
    data: Array.isArray(sharedObjects.remote_control_connections) ? sharedObjects.remote_control_connections : [],
    nextCursor: null,
    state: sharedObjects.remote_control_connections_state ?? defaultRemoteControlConnectionsState(true, false),
    client_id: sharedObjects.local_remote_control_client_id ?? null,
    environment_id: sharedObjects.local_remote_control_environment_id ?? null,
    installation_id: sharedObjects.local_remote_control_installation_id ?? null,
    runtime: {
      computer_use_mode: state.computer.mode,
      physical_host_control: state.computer.physical_host_control === true,
    },
  };
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
  child.stdin.on("error", (error) => {
    state.appServer.status = "error";
    state.appServer.last_error = error.message;
    appendServeLog(state, "app_server_stdin_error", { error: error.message }, "warn");
  });
  child.on("error", (error) => {
    state.appServer.status = "error";
    state.appServer.last_error = error.message;
    appendServeLog(state, "app_server_error", { error: error.message }, "error");
  });
  child.on("exit", (code, signal) => {
    state.appServer.status = "exited";
    state.appServer.pid = null;
    state.appServer.last_error = `exited code=${code} signal=${signal}`;
    rejectPendingRpc(state, new Error(`app-server exited code=${code} signal=${signal}`));
    appendServeLog(state, "app_server_exited", { code, signal }, code === 0 ? "info" : "warn");
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
      appendServeLog(state, "app_server_ready", { pid: state.appServer.pid });
    })
    .catch((error) => {
      state.appServer.status = "error";
      state.appServer.last_error = error.message;
      appendServeLog(state, "app_server_initialize_failed", { error: error.message }, "error");
    });
}

function rejectPendingRpc(state, reason) {
  for (const pending of state.pendingRpc.values()) {
    pending.reject(reason);
  }
  state.pendingRpc.clear();
}

async function stopAppServer(state) {
  rejectPendingRpc(state, new Error("web-mode server is shutting down"));
  await terminateChild(state.appServer.child, "app-server");
}

async function terminateChild(child, label) {
  if (!child || child.exitCode != null || child.signalCode != null) {
    return;
  }

  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode == null && child.signalCode == null) {
        child.kill("SIGKILL");
      }
      resolve();
    }, SHUTDOWN_TIMEOUT_MS);

    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });

    try {
      child.kill("SIGTERM");
    } catch (error) {
      clearTimeout(timer);
      console.error(`[codex-web] failed to terminate ${label}: ${error.message}`);
      resolve();
    }
  });
}

async function closeHttpServer(server) {
  if (!server.listening) {
    return;
  }

  server.closeIdleConnections?.();
  const closePromise = new Promise((resolve, reject) => {
    server.close((error) => {
      if (error && error.code !== "ERR_SERVER_NOT_RUNNING") {
        reject(error);
        return;
      }
      resolve();
    });
  });

  const forceTimer = setTimeout(() => {
    server.closeAllConnections?.();
  }, 500);

  try {
    await closePromise;
  } finally {
    clearTimeout(forceTimer);
  }
}

function browserStatus(state) {
  const { child, cdpPipe, ...status } = state.browser;
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

function formatCapabilityStatus(label, status, detail = null) {
  return detail ? `${label}: ${status} (${detail})` : `${label}: ${status}`;
}

function printStartupSummary(state, url) {
  const browser = browserStatus(state);
  const healthUrl = `${url}__codex/health`;
  const doctorUrl = `${url}__codex/doctor`;
  const tokenNote = state.args.requireToken || isLoopback(state.args.bind) ? "bridge token enabled" : "bridge token required";

  printServeLine("");
  printServeLine("Codex Desktop Web");
  printServeLine("-----------------");
  printServeLine(`URL:         ${url}`);
  printServeLine(`Workspace:   ${redactHome(state.args.workspace)}`);
  printServeLine(`Profile:     ${redactHome(state.args.profile)}`);
  printServeLine(`Codex home:  ${redactHome(state.args.codexHome)}${state.args.isolated ? " (isolated)" : ""}`);
  printServeLine(`Bind:        ${state.args.bind}:${state.args.port === 0 ? new URL(url).port : state.args.port} (${tokenNote})`);
  printServeLine("");
  printServeLine("Runtime");
  printServeLine(`  ${formatCapabilityStatus("App server", state.appServer.status, "stdio bridge")}`);
  printServeLine(`  ${formatCapabilityStatus("Browser Use", browser.mode, browser.reason)}`);
  printServeLine(
    `  ${formatCapabilityStatus(
      "Computer Use",
      state.computer.mode,
      state.computer.physical_host_control ? "desktop session control enabled" : "host desktop variables stripped",
    )}`,
  );
  printServeLine(`  ${formatCapabilityStatus("Chrome native host", state.chrome_native_host.status)}`);
  printServeLine("");
  printServeLine("Diagnostics");
  printServeLine(`  Health:     ${healthUrl}`);
  printServeLine(`  Doctor:     ${doctorUrl}`);
  printServeLine(`  Logs:       ${redactHome(path.join(state.args.logsDir, "serve.jsonl"))}`);
  printServeLine(`  App logs:   ${redactHome(path.join(state.args.logsDir, "app-server.log"))}`);
  printServeLine("");
  printServeLine("Press Ctrl-C to stop Codex Desktop Web.");
  printServeLine("");
}

function portConflictMessage(args, error) {
  if (error?.code !== "EADDRINUSE") {
    return error?.message ?? String(error);
  }
  return [
    `port ${args.port} is already in use on ${args.bind}`,
    `stop the previous devcontainer web server: codex-desktop serve stop --workspace ${JSON.stringify(args.workspace)} --profile ${JSON.stringify(args.profile)}`,
    `choose another port: codex-desktop serve --workspace ${JSON.stringify(args.workspace)} --port 0`,
    `or inspect the listener: ss -ltnp 'sport = :${args.port}'`,
  ].join("\n");
}

function health(state, serverAddress = null) {
  const { args } = state;
  const browser = browserStatus(state);
  const warnings = [];
  if (state.appServer.status === "error" || state.appServer.status === "exited") {
    warnings.push(`app-server ${state.appServer.status}: ${state.appServer.last_error}`);
  }
  if (browser.mode === "disabled") {
    warnings.push(`Browser Use sidecar disabled: ${browser.reason}`);
  }
  if (state.computer.physical_host_control) {
    warnings.push("Computer Use is in desktop mode; in a devcontainer this may target the container desktop session, not the Bluefin host.");
  }
  return {
    package: "codex-desktop-linux",
    mode: "devcontainer-web",
    pid: process.pid,
    server_id: state.serverId,
    loopback_only_default: true,
    bind: args.bind,
    port: serverAddress?.port ?? args.port,
    url: serverAddress ? `http://${args.bind}:${serverAddress.port}/` : null,
    workspace: args.workspace,
    profile: args.profile,
    codex_home: args.codexHome,
    isolated: args.isolated,
    webview_dir: args.webviewDir,
    webview_dir_exists: null,
    started_at: state.startedAt,
    auth: {
      required: true,
      token_present: Boolean(state.token),
    },
    logs: {
      serve_jsonl: path.join(args.logsDir, "serve.jsonl"),
      app_server: path.join(args.logsDir, "app-server.log"),
      browser_use: path.join(args.logsDir, "browser-use.log"),
    },
    diagnostics: {
      status: warnings.length === 0 ? "ok" : "degraded",
      warnings,
      capabilities: {
        app_server_bridge: "stdio",
        browser_sidecar: browser.mode,
        browser_backends: browser.available_backends ?? [],
        computer_use_mode: state.computer.mode,
        chrome_native_host: state.chrome_native_host.status,
        remote_control_controller: state.remoteControl.connections.size > 0 ? "active" : "available",
      },
    },
    app_server: appServerStatus(state),
    browser_use: browser,
    chrome_native_host: state.chrome_native_host,
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
  return serveIndexWithInitialRoute(response, state, indexPath, null);
}

function rewriteIndexAssetUrls(source) {
  return source
    .replaceAll('src="./assets/', 'src="/assets/')
    .replaceAll("src='./assets/", "src='/assets/")
    .replaceAll('href="./assets/', 'href="/assets/')
    .replaceAll("href='./assets/", "href='/assets/");
}

function escapeHtmlAttribute(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function serveIndexWithInitialRoute(response, state, indexPath, initialRoute) {
  let source = rewriteIndexAssetUrls(await fs.readFile(indexPath, "utf8"));
  const scriptTag = '<script src="/__codex/web-mode-bootstrap.js"></script>';
  const routeTag =
    typeof initialRoute === "string" && initialRoute.length > 0
      ? `<meta name="initial-route" content="${escapeHtmlAttribute(initialRoute)}">`
      : null;
  if (routeTag && !source.includes('name="initial-route"')) {
    if (source.includes("</head>")) {
      source = source.replace("</head>", `${routeTag}\n</head>`);
    } else {
      source = `${routeTag}\n${source}`;
    }
  }
  if (!source.includes(scriptTag)) {
    if (source.includes("</head>")) {
      source = source.replace("</head>", `${scriptTag}\n</head>`);
    } else {
      source = `${scriptTag}\n${source}`;
    }
  }
  response.writeHead(200, {
    ...staticHeaders("text/html; charset=utf-8"),
    "x-codex-desktop-web-mode": "1",
  });
  response.end(source);
}

const WEB_MODE_FORCED_FEATURE_GATES = new Set([
  // Exposes the upstream profile-menu Settings entry. Web mode has no upstream
  // feature-state bootstrap, so keep this desktop navigation affordance stable.
  "4166894088",
  // External Chrome control plugin gate.
  "410065390",
  // In-app Browser Use gate.
  "410262010",
  // Computer Use rollout gate for desktop-shaped web mode.
  "1506311413",
  // Remote Connections settings gate.
  "4114442250",
  // Realtime voice mode gate.
  "2380644311",
  // Voice input command gate.
  "4100906017",
  // Global dictation command gate.
  "1244621283",
]);

function forcedFeatureGateExpression(variableName) {
  const expressions = Array.from(WEB_MODE_FORCED_FEATURE_GATES, (gate) => `${variableName}===\`${gate}\``);
  return expressions.length > 0 ? expressions.join("||") : "false";
}

function patchWebModeStatsigGateDefaults(source) {
  const forcedGate = forcedFeatureGateExpression("e");
  const needle = "t(!1,{onMount:(t,n)=>{let r=n.get(i);return r!=null&&t(r.checkGate(e)),n.set(a,t=>t.includes(e)?t:[...t,e])";
  const replacement = `t(${forcedGate},{onMount:(t,n)=>{let r=n.get(i);return r!=null&&t(${forcedGate}||r.checkGate(e)),n.set(a,t=>t.includes(e)?t:[...t,e])`;
  return source.includes(needle) ? source.replace(needle, replacement) : source;
}

function patchWebModeProjectlessOutputDirectory(source) {
  const needle =
    "if(m===`projectless`&&h==null)throw Error(`Projectless conversations require an output directory`);";
  const replacement =
    "if(m===`projectless`&&h==null&&(h=l??t?.[0]??null),m===`projectless`&&h==null)throw Error(`Projectless conversations require an output directory`);";
  return source.includes(needle) ? source.replace(needle, replacement) : source;
}

function patchWebModeAssetSource(target, source) {
  const basename = path.basename(target);
  const extension = path.extname(basename);
  let patched = source;
  if (extension === ".js" || extension === ".mjs") {
    patched = patchWebModeStatsigGateDefaults(patched);
  }
  if (basename.startsWith("electron-menu-shortcuts-")) {
    patched = patched.replaceAll("t?.bindings.filter", "t?.bindings?.filter");
  }
  if (basename.startsWith("reply-")) {
    patched = patchWebModeProjectlessOutputDirectory(patched);
  }
  return patched;
}

function shouldServeSpaFallback(requestPath) {
  if (requestPath === "/" || requestPath.startsWith("/__codex/") || requestPath.startsWith("/assets/")) {
    return false;
  }
  if (WEB_MODE_API_PREFIXES.some((prefix) => requestPath.startsWith(prefix))) {
    return false;
  }
  return path.extname(requestPath) === "";
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

function normalizedTimeoutMs(value) {
  const timeoutMs = Number(value);
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined;
}

async function listWebModeApps(state, { forceRefetch = false } = {}) {
  const now = Date.now();
  if (!forceRefetch && Array.isArray(state.appListCache.data) && now - state.appListCache.fetchedAtMs < 5 * 60 * 1000) {
    return { data: state.appListCache.data, nextCursor: null };
  }

  const data = [];
  let cursor = null;
  do {
    const result = await sendAppServerRpc(
      state,
      "app/list",
      { cursor, limit: 1000, forceRefetch },
      30000,
    );
    if (Array.isArray(result?.data)) {
      data.push(...result.data);
    }
    cursor = result?.nextCursor ?? result?.next_cursor ?? null;
  } while (cursor != null);

  state.appListCache = { data, fetchedAtMs: now };
  return { data, nextCursor: null };
}

async function webModeConnectorById(state, connectorId) {
  const { data } = await listWebModeApps(state);
  return data.find((app) => app?.id === connectorId) ?? null;
}

function webModeConnectorDetail(app) {
  return {
    ...app,
    actions: Array.isArray(app.actions) ? app.actions : [],
    link_params_schema: app.link_params_schema ?? null,
    supported_auth:
      Array.isArray(app.supported_auth) && app.supported_auth.length > 0 ? app.supported_auth : [{ type: "OAUTH" }],
  };
}

function connectorFallbackInstallUrl(app, { addConnectorLink = false } = {}) {
  const installUrl = typeof app?.installUrl === "string" && app.installUrl.trim().length > 0 ? app.installUrl : null;
  if (!installUrl) {
    return null;
  }
  try {
    const url = new URL(installUrl);
    const params = new URLSearchParams([
      ["connector", app.id],
      ["product-sku", "CODEX"],
      ["referrer", "codex"],
    ]);
    if (addConnectorLink) {
      params.set("add-connector-link", "true");
    }
    url.hash = `settings/Connectors?${params.toString()}`;
    return url.toString();
  } catch {
    return installUrl;
  }
}

function connectorLogoColor(input) {
  const digest = crypto.createHash("sha256").update(input).digest();
  const hue = digest[0] % 360;
  return `hsl(${hue} 72% 45%)`;
}

function connectorLogoInitials(name) {
  const words = String(name ?? "")
    .replace(/[^a-z0-9 ]/gi, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) {
    return "C";
  }
  return words
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join("");
}

function connectorLogoPayload(app, theme) {
  const initials = connectorLogoInitials(app?.name);
  const foreground = theme === "dark" ? "#111827" : "#ffffff";
  const background = connectorLogoColor(app?.id ?? app?.name ?? "connector");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${background}"/><text x="32" y="39" text-anchor="middle" font-family="Inter,Arial,sans-serif" font-size="24" font-weight="700" fill="${foreground}">${initials}</text></svg>`;
  return {
    body: {
      contentType: "image/svg+xml",
      base64: Buffer.from(svg).toString("base64"),
    },
  };
}

async function handleAipRequest(request, response, state, url) {
  const pathParts = url.pathname.split("/").filter(Boolean);
  if (pathParts[0] !== "aip" || pathParts[1] !== "connectors") {
    return false;
  }

  if (request.method === "GET" && pathParts.length === 2) {
    jsonResponse(response, 200, await listWebModeApps(state, { forceRefetch: url.searchParams.get("forceRefetch") === "true" }));
    return true;
  }

  if (request.method === "POST" && pathParts[2] === "links" && (pathParts[3] === "oauth" || pathParts[3] === "noauth")) {
    const body = await readJsonRequest(request);
    const connectorId = body?.connector_id ?? body?.connectorId;
    const app = typeof connectorId === "string" ? await webModeConnectorById(state, connectorId) : null;
    if (!app) {
      jsonResponse(response, 404, { error: "connector_not_found" });
      return true;
    }
    if (pathParts[3] === "noauth") {
      jsonResponse(response, 200, { link: { connector_id: app.id, name: app.name, owner_profile: null } });
      return true;
    }
    const redirectUrl =
      (typeof body?.post_auth_url === "string" && body.post_auth_url.trim().length > 0
        ? body.post_auth_url
        : connectorFallbackInstallUrl(app, { addConnectorLink: true })) ?? app.installUrl;
    jsonResponse(response, 200, { redirect_url: redirectUrl });
    return true;
  }

  const connectorId = pathParts[2] ? decodeURIComponent(pathParts[2]) : null;
  if (!connectorId || pathParts.length < 3) {
    jsonResponse(response, 404, { error: "connector_not_found" });
    return true;
  }

  const app = await webModeConnectorById(state, connectorId);
  if (!app) {
    jsonResponse(response, 404, { error: "connector_not_found" });
    return true;
  }

  if (request.method === "GET" && pathParts.length === 3) {
    jsonResponse(response, 200, webModeConnectorDetail(app));
    return true;
  }

  if (request.method === "GET" && pathParts[3] === "link") {
    jsonResponse(response, 200, { link: null });
    return true;
  }

  if (request.method === "GET" && pathParts[3] === "logo") {
    jsonResponse(response, 200, connectorLogoPayload(app, url.searchParams.get("theme") === "dark" ? "dark" : "light"));
    return true;
  }

  jsonResponse(response, 404, { error: "not_found" });
  return true;
}

const LOCAL_ASSET_EXTENSIONS = new Set([".avif", ".gif", ".ico", ".jpeg", ".jpg", ".png", ".svg", ".webp"]);
const LOCAL_ASSET_MAX_BYTES = 10 * 1024 * 1024;

async function realPathIfExists(targetPath) {
  try {
    return await fs.realpath(targetPath);
  } catch {
    return null;
  }
}

function pathWithinRoot(targetPath, rootPath) {
  return targetPath === rootPath || targetPath.startsWith(`${rootPath}${path.sep}`);
}

async function localAssetRoots(state) {
  const candidates = [
    state.args.appDir,
    state.args.codexHome,
    state.args.profile,
    process.env.HOME,
    process.env.XDG_CACHE_HOME,
    process.env.XDG_STATE_HOME,
  ].filter((candidate) => typeof candidate === "string" && candidate.trim().length > 0);
  const roots = [];
  for (const candidate of candidates) {
    const real = await realPathIfExists(candidate);
    if (real && !roots.includes(real)) {
      roots.push(real);
    }
  }
  return roots;
}

async function serveLocalAsset(request, response, state, url) {
  if (!authorizeBridgeRequest(request, response, state, url)) {
    return;
  }
  if (request.method !== "GET") {
    jsonResponse(response, 405, { error: "method_not_allowed" });
    return;
  }

  const requestedPath = url.searchParams.get("path")?.replace(/[?#].*$/, "");
  if (!requestedPath || !path.isAbsolute(requestedPath)) {
    jsonResponse(response, 400, { error: "missing_or_invalid_path" });
    return;
  }

  const ext = path.extname(requestedPath).toLowerCase();
  if (!LOCAL_ASSET_EXTENSIONS.has(ext)) {
    jsonResponse(response, 415, { error: "unsupported_asset_type" });
    return;
  }

  const realPath = await realPathIfExists(requestedPath);
  if (!realPath) {
    textResponse(response, 404, "Not found\n");
    return;
  }

  const roots = await localAssetRoots(state);
  if (!roots.some((root) => pathWithinRoot(realPath, root))) {
    textResponse(response, 403, "Forbidden\n");
    return;
  }

  const stat = await fs.stat(realPath);
  if (!stat.isFile() || stat.size > LOCAL_ASSET_MAX_BYTES) {
    textResponse(response, 403, "Forbidden\n");
    return;
  }

  response.writeHead(200, staticHeaders(TEXT_MIME_TYPES.get(ext) ?? "application/octet-stream"));
  response.end(await fs.readFile(realPath));
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

async function readJsonFile(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function removeMacosSidecarFiles(root) {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(root, entry.name);
      if (entry.isDirectory()) {
        await removeMacosSidecarFiles(target);
      } else if (entry.name.includes(":com.apple.")) {
        await fs.rm(target, { force: true });
      }
    }),
  );
}

async function copyDirectoryAtomic(source, destination, temporaryPrefix) {
  const parent = path.dirname(destination);
  const temporary = path.join(parent, `${temporaryPrefix}-${process.pid}-${Date.now()}`);
  await fs.rm(temporary, { recursive: true, force: true });
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  await fs.cp(source, temporary, { recursive: true, force: true });
  await removeMacosSidecarFiles(temporary);
  await fs.rm(destination, { recursive: true, force: true });
  await fs.rename(temporary, destination);
}

async function syncBundledMarketplace(args, pluginNames) {
  const sourceRoot = path.join(args.appDir, "resources", "plugins", "openai-bundled");
  const sourceMarketplace = path.join(sourceRoot, ".agents", "plugins", "marketplace.json");
  const marketplaceRoot = path.join(args.codexHome, ".tmp", "bundled-marketplaces", "openai-bundled");
  const marketplacePluginsDir = path.join(marketplaceRoot, ".agents", "plugins");
  const marketplaceLocalPluginsDir = path.join(marketplaceRoot, "plugins");

  await fs.mkdir(marketplacePluginsDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(marketplaceLocalPluginsDir, { recursive: true, mode: 0o700 });
  const allowedPlugins = new Set(pluginNames);
  let marketplace = {
    name: "openai-bundled",
    interface: { displayName: "OpenAI Bundled" },
    plugins: [],
  };
  if (await exists(sourceMarketplace)) {
    marketplace = await readJsonFile(sourceMarketplace);
    marketplace.plugins = Array.isArray(marketplace.plugins)
      ? marketplace.plugins.filter((plugin) => allowedPlugins.has(plugin?.name))
      : [];
  }

  const marketplacePluginNames = new Set(marketplace.plugins.map((plugin) => plugin?.name).filter(Boolean));
  for (const pluginName of pluginNames) {
    if (marketplacePluginNames.has(pluginName)) {
      continue;
    }
    const pluginJsonPath = path.join(sourceRoot, "plugins", pluginName, ".codex-plugin", "plugin.json");
    if (!(await exists(pluginJsonPath))) {
      continue;
    }
    let category = "Productivity";
    try {
      const manifest = await readJsonFile(pluginJsonPath);
      category = manifest?.interface?.category || category;
    } catch {
      // Keep the generated marketplace usable even if a local manifest drifts.
    }
    marketplace.plugins.push({
      name: pluginName,
      source: { source: "local", path: `./plugins/${pluginName}` },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category,
    });
  }
  marketplace.plugins = marketplace.plugins.filter((plugin) => allowedPlugins.has(plugin?.name));
  await fs.writeFile(path.join(marketplacePluginsDir, "marketplace.json"), `${JSON.stringify(marketplace, null, 2)}\n`);

  await Promise.all(
    pluginNames.map(async (pluginName) => {
      const sourcePlugin = path.join(sourceRoot, "plugins", pluginName);
      const marketplacePlugin = path.join(marketplaceLocalPluginsDir, pluginName);
      if (!(await exists(path.join(sourcePlugin, ".codex-plugin", "plugin.json")))) {
        return;
      }
      await copyDirectoryAtomic(sourcePlugin, marketplacePlugin, `.marketplace-${pluginName}`);
    }),
  );
}

async function syncBundledPluginCache(args, pluginName) {
  const sourcePlugin = path.join(args.appDir, "resources", "plugins", "openai-bundled", "plugins", pluginName);
  const pluginJsonPath = path.join(sourcePlugin, ".codex-plugin", "plugin.json");
  if (!(await exists(pluginJsonPath))) {
    return false;
  }

  const pluginJson = await readJsonFile(pluginJsonPath);
  const version = typeof pluginJson.version === "string" ? pluginJson.version.trim() : "";
  if (version.length === 0) {
    return false;
  }

  const cacheRoot = path.join(args.codexHome, "plugins", "cache", "openai-bundled", pluginName);
  const cachePlugin = path.join(cacheRoot, version);
  await copyDirectoryAtomic(sourcePlugin, cachePlugin, `.${pluginName}-${version}.tmp`);

  const latestLink = path.join(cacheRoot, "latest");
  await fs.rm(latestLink, { recursive: true, force: true });
  await fs.symlink(cachePlugin, latestLink, "dir");
  return true;
}

function bundledPluginNamesForState(state) {
  if (state.computer.physical_host_control) {
    return BUNDLED_PLUGIN_NAMES;
  }
  return BUNDLED_PLUGIN_NAMES.filter((pluginName) => pluginName !== "computer-use");
}

function chromeExtensionHostArch() {
  switch (process.arch) {
    case "x64":
      return "x64";
    case "arm64":
      return "arm64";
    default:
      return null;
  }
}

async function chromeExtensionMetadata(pluginDir) {
  const scriptsDir = path.join(pluginDir, "scripts");
  try {
    const metadata = await readJsonFile(path.join(scriptsDir, "extension-id.json"));
    if (typeof metadata.extensionId === "string" && typeof metadata.extensionHostName === "string") {
      return {
        extensionId: metadata.extensionId,
        hostName: metadata.extensionHostName,
      };
    }
  } catch {
    // Fall through to the older installManifest.mjs source format.
  }

  const manifestSource = await fs.readFile(path.join(scriptsDir, "installManifest.mjs"), "utf8");
  return {
    extensionId: /extensionId\s*:\s*"([a-p]{32})"/.exec(manifestSource)?.[1] ?? null,
    hostName: /extensionHostName\s*:\s*"([A-Za-z0-9_.]+)"/.exec(manifestSource)?.[1] ?? null,
  };
}

async function writeChromeNativeHostManifests(args) {
  const arch = chromeExtensionHostArch();
  if (arch == null) {
    return { status: "unsupported_arch", arch: process.arch, manifests: [] };
  }

  const pluginDir = path.join(args.codexHome, "plugins", "cache", "openai-bundled", "chrome", "latest");
  const hostPath = path.join(pluginDir, "extension-host", "linux", arch, "extension-host");
  if (!(await exists(hostPath))) {
    return { status: "host_missing", arch, host_path: hostPath, manifests: [] };
  }

  const { extensionId, hostName } = await chromeExtensionMetadata(pluginDir);
  if (!/^[a-p]{32}$/.test(extensionId ?? "") || !/^[A-Za-z0-9_.]+$/.test(hostName ?? "")) {
    return { status: "metadata_missing", arch, host_path: hostPath, manifests: [] };
  }

  const manifest = JSON.stringify({
    name: hostName,
    description: "Codex chrome native messaging host",
    type: "stdio",
    path: hostPath,
    allowed_origins: [`chrome-extension://${extensionId}/`],
  });

  const homeDir = process.env.HOME || args.workspace;
  const manifests = await Promise.all(
    [
      { browser: "google-chrome", relative: ".config/google-chrome/NativeMessagingHosts" },
      { browser: "brave", relative: ".config/BraveSoftware/Brave-Browser/NativeMessagingHosts" },
      { browser: "chromium", relative: ".config/chromium/NativeMessagingHosts" },
    ].map(async ({ browser, relative }) => {
      const directory = path.join(homeDir, relative);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const manifestPath = path.join(directory, `${hostName}.json`);
      await fs.writeFile(manifestPath, manifest, { mode: 0o600 });
      return { browser, path: manifestPath };
    }),
  );
  return { status: "installed", arch, host_path: hostPath, extension_id: extensionId, host_name: hostName, manifests };
}

async function syncBundledPlugins(args, pluginNames = BUNDLED_PLUGIN_NAMES) {
  const syncedPlugins = [];
  for (const pluginName of pluginNames) {
    if (await syncBundledPluginCache(args, pluginName)) {
      syncedPlugins.push(pluginName);
    }
  }
  if (syncedPlugins.length > 0) {
    await syncBundledMarketplace(args, syncedPlugins);
  }
  let chromeNativeHost = { status: "not_synced", manifests: [] };
  if (syncedPlugins.includes("chrome")) {
    chromeNativeHost = await writeChromeNativeHostManifests(args);
  }
  return {
    synced_plugins: syncedPlugins,
    chrome_native_host: chromeNativeHost,
  };
}

async function localFileMetadata(filePath) {
  const stat = await fs.stat(filePath);
  return {
    path: filePath,
    isFile: stat.isFile(),
    isDirectory: stat.isDirectory(),
    sizeBytes: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

async function localWorkspaceRootMetadata(rootPath) {
  if (typeof rootPath !== "string" || rootPath.trim().length === 0) {
    throw new Error("workspace root path is required");
  }
  return localFileMetadata(path.resolve(rootPath));
}

function sanitizeProjectName(projectName) {
  const sanitized = String(projectName ?? "")
    .trim()
    .replace(/[\\/:\0]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^\.+$/, "")
    .slice(0, 80);
  return sanitized.length > 0 ? sanitized : "New project";
}

async function createWorkspaceProject(args, projectName) {
  const basePath = path.resolve(args.workspace);
  const baseName = sanitizeProjectName(projectName);
  let targetPath = path.join(basePath, baseName);
  const baseWithSeparator = `${basePath}${path.sep}`;
  if (targetPath !== basePath && !targetPath.startsWith(baseWithSeparator)) {
    throw new Error("project path escapes workspace");
  }

  for (let attempt = 2; await exists(targetPath); attempt += 1) {
    targetPath = path.join(basePath, `${baseName} ${attempt}`);
  }

  await fs.mkdir(targetPath, { recursive: true, mode: 0o700 });
  return localFileMetadata(targetPath);
}

async function captureCommand(command, args, timeoutMs = 30000) {
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out`));
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      if (code === 1) {
        resolve("");
        return;
      }
      reject(new Error(`${command} exited code=${code} signal=${signal}: ${stderr.trim()}`));
    });
  });
}

async function selectWorkspaceDirectory(args, initialRoot) {
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return { cancelled: true, reason: "no graphical session available" };
  }

  const initialPath = path.resolve(
    typeof initialRoot === "string" && initialRoot.trim().length > 0 ? initialRoot : args.workspace,
  );
  const kdialog = await findExecutable("kdialog");
  if (kdialog) {
    const selected = await captureCommand(kdialog, ["--getexistingdirectory", initialPath]);
    return selected ? await localWorkspaceRootMetadata(selected) : { cancelled: true };
  }

  const zenity = await findExecutable("zenity");
  if (zenity) {
    const selected = await captureCommand(zenity, [
      "--file-selection",
      "--directory",
      `--filename=${initialPath.endsWith(path.sep) ? initialPath : `${initialPath}${path.sep}`}`,
    ]);
    return selected ? await localWorkspaceRootMetadata(selected) : { cancelled: true };
  }

  return { cancelled: true, reason: "no supported folder picker found" };
}

function chromeProfileRoots(homeDir = process.env.HOME || "") {
  return [
    path.join(homeDir, ".config", "BraveSoftware", "Brave-Browser"),
    path.join(homeDir, ".config", "google-chrome"),
    path.join(homeDir, ".config", "google-chrome-beta"),
    path.join(homeDir, ".config", "google-chrome-unstable"),
    path.join(homeDir, ".config", "chromium"),
  ];
}

async function chromeExtensionInstalled(extensionId) {
  if (typeof extensionId !== "string" || !/^[a-p]{32}$/.test(extensionId)) {
    return { installed: false };
  }

  for (const root of chromeProfileRoots()) {
    let profiles;
    try {
      profiles = await fs.readdir(root, { withFileTypes: true });
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
      continue;
    }

    for (const profile of profiles) {
      if (!profile.isDirectory()) {
        continue;
      }
      if (await exists(path.join(root, profile.name, "Extensions", extensionId))) {
        return { installed: true };
      }
    }
  }

  return { installed: false };
}

function conversationTurns(conversationState) {
  const turns = conversationState?.turns ?? conversationState?.thread?.turns ?? [];
  return Array.isArray(turns) ? turns : [];
}

function turnStatus(turn) {
  if (typeof turn?.status === "string") {
    return turn.status;
  }
  if (typeof turn?.status?.type === "string") {
    return turn.status.type;
  }
  return null;
}

function findActiveTurn(conversationState) {
  return conversationTurns(conversationState)
    .slice()
    .reverse()
    .find((turn) => {
      const status = String(turnStatus(turn) ?? "")
        .replaceAll("_", "")
        .toLowerCase();
      return turn?.turnId != null && status === "inprogress";
    });
}

async function interruptConversation(state, params) {
  const conversationId = params?.conversationId;
  if (typeof conversationId !== "string" || conversationId.trim().length === 0) {
    return { interrupted: false, reason: "missing-conversation-id" };
  }

  let conversationState = params?.conversationState ?? null;
  let activeTurn = findActiveTurn(conversationState);
  let sessionId = conversationState?.id ?? conversationState?.sessionId ?? conversationId;
  if (activeTurn == null) {
    const threadResult = await sendAppServerRpc(state, "thread/read", {
      threadId: conversationId,
      includeTurns: true,
    }).catch(() => null);
    if (threadResult != null) {
      const thread = threadResult?.thread ?? threadResult;
      conversationState = thread;
      activeTurn = findActiveTurn(thread);
      sessionId = thread?.sessionId ?? thread?.id ?? conversationId;
    }
  }

  if (activeTurn == null) {
    const turnsResult = await sendAppServerRpc(state, "thread/turns/list", {
      threadId: conversationId,
      cursor: null,
      limit: 100,
    }).catch(() => null);
    const turns = turnsResult?.turns ?? turnsResult?.data ?? [];
    if (Array.isArray(turns)) {
      activeTurn = findActiveTurn({ turns });
    }
  }

  if (activeTurn == null) {
    const cleanResult = await sendAppServerRpc(state, "thread/backgroundTerminals/clean", {
      threadId: sessionId,
    }).catch(() => null);
    return { interrupted: false, cleanedBackgroundTerminals: cleanResult != null, reason: "no-active-turn" };
  }

  const turnId = activeTurn.turnId;
  await sendAppServerRpc(state, "turn/interrupt", { threadId: sessionId, turnId });
  return { interrupted: true, threadId: sessionId, turnId };
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
        response.writeHead(200, staticHeaders("text/javascript; charset=utf-8"));
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
          const result = await routeAppServerRpc(
            state,
            message.params?.method,
            message.params?.params ?? {},
            normalizedTimeoutMs(message.params?.timeoutMs),
          );
          jsonResponse(response, 200, { ok: true, result });
          return;
        }
        if (message?.method === "appServer.write") {
          if (!state.appServer.child || !state.appServer.child.stdin.writable) {
            jsonResponse(response, 503, { error: "app_server_unavailable" });
            return;
          }
          state.appServer.child.stdin.write(`${JSON.stringify(message.params?.message ?? {})}\n`);
          jsonResponse(response, 200, { ok: true });
          return;
        }
        if (message?.method === "desktopHost.request") {
          try {
            const result = await handleDesktopHostRequest(
              state,
              message.params?.method,
              message.params?.params ?? {},
            );
            jsonResponse(response, 200, { ok: true, result });
          } catch (error) {
            jsonResponse(response, error.statusCode ?? 500, {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
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
        if (message?.method === "fs.metadata") {
          const hostId = connectionHostId(message.params ?? {});
          if (isRemoteControlHostId(hostId)) {
            jsonResponse(response, 200, {
              ok: true,
              result: {
                path: message.params?.path,
                ...(await remoteControlAppServerRequest(state, hostId, "fs/getMetadata", { path: message.params?.path })),
              },
            });
          } else {
            jsonResponse(response, 200, {
              ok: true,
              result: await localFileMetadata(message.params?.path),
            });
          }
          return;
        }
        if (message?.method === "workspace.rootMetadata") {
          jsonResponse(response, 200, {
            ok: true,
            result: await localWorkspaceRootMetadata(message.params?.root),
          });
          return;
        }
        if (message?.method === "workspace.createProject") {
          jsonResponse(response, 200, {
            ok: true,
            result: await createWorkspaceProject(state.args, message.params?.projectName),
          });
          return;
        }
        if (message?.method === "workspace.selectDirectory") {
          jsonResponse(response, 200, {
            ok: true,
            result: await selectWorkspaceDirectory(state.args, message.params?.initialRoot),
          });
          return;
        }
        if (message?.method === "chromeExtension.installed") {
          jsonResponse(response, 200, {
            ok: true,
            result: await chromeExtensionInstalled(message.params?.extensionId),
          });
          return;
        }
        if (message?.method === "conversation.interrupt") {
          jsonResponse(response, 200, {
            ok: true,
            result: await interruptConversation(state, message.params ?? {}),
          });
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
        const result = await sendAppServerRpc(state, method, message.params ?? {}, normalizedTimeoutMs(message.timeoutMs));
        jsonResponse(response, 200, { id: message.id ?? null, result });
        return;
      }

      if (url.pathname === "/__codex/app-server/events") {
        if (!authorizeBridgeRequest(request, response, state, url)) {
          return;
        }
        response.writeHead(200, {
          ...staticHeaders("text/event-stream; charset=utf-8"),
          connection: "keep-alive",
        });
        response.write(": connected\n\n");
        state.sseClients.add(response);
        const heartbeat = setInterval(() => {
          response.write(`: heartbeat ${Date.now()}\n\n`);
        }, 15000);
        request.on("close", () => {
          clearInterval(heartbeat);
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

      if (url.pathname === "/__codex/local-file") {
        await serveLocalAsset(request, response, state, url);
        return;
      }

      if (url.pathname.startsWith("/aip/")) {
        if (!authorizeBridgeRequest(request, response, state, url)) {
          return;
        }
        if (await handleAipRequest(request, response, state, url)) {
          return;
        }
      }

      if (url.pathname === "/wham/remote/control/clients") {
        if (request.method !== "GET") {
          jsonResponse(response, 405, { error: "method_not_allowed" });
          return;
        }
        jsonResponse(response, 200, await webModeRemoteControlClientsResponse(state));
        return;
      }

      if (url.pathname === "/wham/accounts/check") {
        if (request.method !== "GET") {
          jsonResponse(response, 405, { error: "method_not_allowed" });
          return;
        }
        const accountResult = await sendAppServerRpc(state, "account/read", { refreshToken: false });
        jsonResponse(response, 200, webModeWhamAccountsCheckResponse(accountResult));
        return;
      }

      if (url.pathname === "/wham/tasks/list") {
        if (request.method !== "GET") {
          jsonResponse(response, 405, { error: "method_not_allowed" });
          return;
        }
        jsonResponse(response, 200, { items: [], cursor: null });
        return;
      }

      if (url.pathname === "/wham/usage") {
        if (request.method !== "GET") {
          jsonResponse(response, 405, { error: "method_not_allowed" });
          return;
        }
        const [rateLimitResult, accountResult] = await Promise.all([
          sendAppServerRpc(state, "account/rateLimits/read", {}),
          sendAppServerRpc(state, "account/read", { refreshToken: false }).catch(() => null),
        ]);
        jsonResponse(response, 200, webModeWhamUsageResponse(rateLimitResult, accountResult));
        return;
      }

      if (url.pathname === "/beacons/home") {
        if (request.method !== "GET") {
          jsonResponse(response, 405, { error: "method_not_allowed" });
          return;
        }
        jsonResponse(response, 200, { beacon_ui_response: null });
        return;
      }

      const target = await resolveStaticPath(state.args.webviewDir, url.pathname);
      if (!target) {
        textResponse(response, 403, "Forbidden\n");
        return;
      }

      let stat = null;
      try {
        stat = await fs.stat(target);
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
      if (!stat?.isFile()) {
        if (shouldServeSpaFallback(url.pathname)) {
          await serveIndexWithInitialRoute(
            response,
            state,
            path.join(state.args.webviewDir, "index.html"),
            `${url.pathname}${url.search}`,
          );
          return;
        }
        textResponse(response, 404, "Not found\n");
        return;
      }

      if (path.basename(target) === "index.html") {
        await serveIndex(response, state, target);
        return;
      }

      response.writeHead(200, staticHeaders(TEXT_MIME_TYPES.get(path.extname(target).toLowerCase()) ?? "application/octet-stream"));
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

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readServeState(args) {
  try {
    const state = JSON.parse(await fs.readFile(args.serveStatePath, "utf8"));
    return state && typeof state === "object" ? state : null;
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeServeState(state, url, address) {
  const body = {
    pid: process.pid,
    server_id: state.serverId,
    url,
    bind: state.args.bind,
    port: address.port,
    workspace: state.args.workspace,
    profile: state.args.profile,
    codex_home: state.args.codexHome,
    started_at: state.startedAt,
    health: `${url}__codex/health`,
    logs: {
      serve_jsonl: path.join(state.args.logsDir, "serve.jsonl"),
      app_server: path.join(state.args.logsDir, "app-server.log"),
      browser_use: path.join(state.args.logsDir, "browser-use.log"),
    },
  };
  await fs.mkdir(path.dirname(state.args.serveStatePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(state.args.serveStatePath, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
}

async function removeServeState(args) {
  await fs.rm(args.serveStatePath, { force: true }).catch(() => {});
}

async function fetchServeHealth(url) {
  try {
    return await fetchJson(`${url.replace(/\/?$/, "/")}__codex/health`, { timeoutMs: 1000 });
  } catch (error) {
    return { error: error.message };
  }
}

async function runningServeState(args, state) {
  if (!state?.pid || !pidAlive(state.pid) || typeof state.url !== "string" || state.url.length === 0) {
    return { running: false, health: null };
  }
  const healthBody = await fetchServeHealth(state.url);
  const running =
    !healthBody?.error &&
    healthBody.package === "codex-desktop-linux" &&
    healthBody.mode === "devcontainer-web" &&
    healthBody.pid === state.pid &&
    healthBody.server_id === state.server_id &&
    healthBody.profile === state.profile &&
    healthBody.workspace === state.workspace;
  return { running, health: healthBody };
}

async function serve(args) {
  if (!isLoopback(args.bind) && !args.requireToken) {
    throw new Error("non-loopback bind requires --require-token");
  }

  await ensureProfileDirs(args);
  const existing = await readServeState(args);
  const existingRuntime = await runningServeState(args, existing);
  if (existingRuntime.running) {
    throw new Error(
      [
        `codex web mode is already running for this profile: ${existing.url ?? `pid ${existing.pid}`}`,
        `stop it with: codex-desktop serve stop --workspace ${JSON.stringify(args.workspace)} --profile ${JSON.stringify(args.profile)}`,
      ].join("\n"),
    );
  }
  if (existing) {
    await removeServeState(args);
  }
  const state = createState(args);
  appendServeLog(state, "starting", {
    workspace: args.workspace,
    profile: args.profile,
    codex_home: args.codexHome,
    bind: args.bind,
    port: args.port,
    isolated: args.isolated,
  });
  const pluginSync = await syncBundledPlugins(args, bundledPluginNamesForState(state));
  state.chrome_native_host = pluginSync.chrome_native_host;
  appendServeLog(state, "bundled_plugins_synced", pluginSync);
  await startBrowserSidecar(state);
  appendServeLog(state, "browser_sidecar_status", browserStatus(state), state.browser.mode === "disabled" ? "warn" : "info");
  startAppServer(state);
  appendServeLog(state, "app_server_starting", appServerStatus(state));
  const server = createServer(state);
  let shutdownPromise = null;

  const shutdown = (exitCode = null, reason = "shutdown") => {
    shutdownPromise ??= (async () => {
      appendServeLog(state, "shutdown_started", { reason }, exitCode == null ? "info" : "warn");
      printServeLine(`[codex-web] ${reason}; shutting down`);
      await closeHttpServer(server);
      await Promise.all([stopRemoteControlConnections(state), stopBrowserSidecar(state), stopAppServer(state)]);
      await removeServeState(args);
      appendServeLog(state, "shutdown_complete", { reason });
    })()
      .catch((error) => {
        appendServeLog(state, "shutdown_failed", { error: error.message }, "error");
        printServeLine(`[codex-web] shutdown failed: ${error.message}`);
      })
      .finally(() => {
        if (exitCode != null) {
          process.exit(exitCode);
        }
      });
    return shutdownPromise;
  };

  process.once("SIGINT", () => {
    void shutdown(130, "received SIGINT");
  });
  process.once("SIGHUP", () => {
    void shutdown(129, "received SIGHUP");
  });
  process.once("SIGTERM", () => {
    void shutdown(143, "received SIGTERM");
  });

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(args.port, args.bind, resolve);
    });
  } catch (error) {
    appendServeLog(state, "listen_failed", { code: error.code, message: error.message }, "error");
    await Promise.all([stopRemoteControlConnections(state), stopBrowserSidecar(state), stopAppServer(state)]);
    throw new Error(portConflictMessage(args, error));
  }

  const address = server.address();
  const url = `http://${args.bind}:${address.port}/`;
  await writeServeState(state, url, address);
  appendServeLog(state, "listening", {
    url,
    health: `${url}__codex/health`,
    doctor: `${url}__codex/doctor`,
  });
  printServeLine(`[codex-web] serving ${url}`);

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
    await shutdown(null, "once health check complete");
    return;
  }

  printStartupSummary(state, url);
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

async function status(args) {
  const state = await readServeState(args);
  const runtime = await runningServeState(args, state);
  if (!runtime.running) {
    if (state) {
      await removeServeState(args);
    }
    process.stdout.write(
      `${JSON.stringify(
        {
          status: runtime.health?.error ? "stale" : "not_running",
          profile: args.profile,
          state_path: args.serveStatePath,
          stale_pid: state?.pid ?? null,
          stale_url: state?.url ?? null,
          health_result: runtime.health,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        status: "running",
        ...state,
        health_result: runtime.health,
      },
      null,
      2,
    )}\n`,
  );
}

async function waitForPidExit(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !pidAlive(pid);
}

async function stop(args) {
  const state = await readServeState(args);
  const runtime = await runningServeState(args, state);
  if (!runtime.running) {
    if (state) {
      await removeServeState(args);
    }
    process.stdout.write(`codex web mode is not running for profile ${args.profile}\n`);
    return;
  }

  process.kill(state.pid, "SIGTERM");
  const stopped = await waitForPidExit(state.pid);
  if (!stopped) {
    throw new Error(`timed out stopping codex web mode pid ${state.pid}`);
  }
  await removeServeState(args);
  process.stdout.write(`stopped codex web mode pid ${state.pid}\n`);
}

async function doctor(args) {
  const webviewExists = await exists(args.webviewDir);
  process.stdout.write(`Codex Desktop Linux doctor\n`);
  process.stdout.write(`mode: devcontainer-web\n`);
  process.stdout.write(`workspace: ${args.workspace}\n`);
  process.stdout.write(`profile: ${args.profile}\n`);
  process.stdout.write(`codex_home: ${args.codexHome}${args.isolated ? " (isolated)" : ""}\n`);
  process.stdout.write(`listener_default: loopback-only\n`);
  process.stdout.write(`webview_dir: ${args.webviewDir} (${webviewExists ? "ok" : "missing"})\n`);
  process.stdout.write(`logs: ${path.join(args.logsDir, "serve.jsonl")}\n`);
  process.stdout.write(`app_server: stdio bridge; live status is available from /__codex/health while serve is running\n`);
  process.stdout.write(`Browser Use: container-chromium or playwright-cdp; live CDP status is available from /__codex/browser/status\n`);
  process.stdout.write(`Chrome native host: synced during serve startup when the bundled chrome plugin is present\n`);
  process.stdout.write(`Computer Use: auto-detects desktop vs browser-only; set CODEX_COMPUTER_CONTROL_MODE=desktop or browser-only to override\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "serve") {
    await serve(args);
  } else if (args.command === "status") {
    await status(args);
  } else if (args.command === "stop") {
    await stop(args);
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
