#!/usr/bin/env node

import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";

const DEFAULT_OUT = "dist-next/web-mode/contract-matrix.json";
const REQUEST_TIMEOUT_MS = 5000;

const SCREEN_CONTRACTS = [
  {
    id: "runtime",
    name: "Runtime Classifier",
    route: "/__codex/health",
    checks: [
      {
        id: "health",
        description: "serve exposes health with runtime capability state",
        run: async (context) => {
          const response = await context.getJson("/__codex/health", { token: false });
          context.health = response.body;
          return passIf(response.status === 200 && response.body?.package === "codex-desktop-linux", {
            status: response.status,
            mode: response.body?.mode,
            capabilities: response.body?.diagnostics?.capabilities ?? null,
          });
        },
      },
      {
        id: "bridge-token",
        description: "private bridge rejects missing tokens",
        run: async (context) => {
          const response = await context.postJson("/__codex/bridge", { method: "health.read" }, { token: false });
          return passIf(response.status === 401, { status: response.status, body: response.body });
        },
      },
      {
        id: "bootstrap-token",
        description: "bootstrap exposes the browser bridge token",
        run: async (context) => {
          await context.ensureToken();
          return passIf(typeof context.token === "string" && context.token.length > 0, { token_present: Boolean(context.token) });
        },
      },
    ],
  },
  {
    id: "chat",
    name: "Chat",
    route: "/",
    checks: [
      {
        id: "spa-root",
        description: "root route serves the webview shell",
        run: async (context) => {
          const response = await context.getText("/");
          return passIf(response.status === 200 && response.text.includes("/__codex/web-mode-bootstrap.js"), {
            status: response.status,
            bootstrap_tag: response.text.includes("/__codex/web-mode-bootstrap.js"),
          });
        },
      },
      {
        id: "thread-list",
        description: "app-server thread list bridge returns desktop-shaped data",
        hostCalls: ["appServer.rpc:thread/list"],
        run: async (context) => {
          const result = await context.bridgeRpc("thread/list", { limit: 1 });
          return passIf(Array.isArray(result?.items) || Array.isArray(result?.threads) || Array.isArray(result?.data), {
            keys: objectKeys(result),
          });
        },
      },
    ],
  },
  {
    id: "settings",
    name: "Settings",
    route: "/settings",
    checks: [
      {
        id: "settings-route-refresh",
        description: "refreshing a settings route keeps the initial route instead of going home",
        run: async (context) => {
          const response = await context.getText("/settings");
          return passIf(
            response.status === 200 &&
              response.text.includes('/__codex/web-mode-bootstrap.js') &&
              response.text.includes('name="initial-route"'),
            {
              status: response.status,
              has_initial_route: response.text.includes('name="initial-route"'),
            },
          );
        },
      },
      {
        id: "settings-host-fallbacks",
        description: "bootstrap contains desktop-shaped settings fallbacks",
        run: async (context) => {
          const source = await context.bootstrapSource();
          const markers = [
            "hotkey-window-hotkey-state",
            "batch-write-config-value-for-host",
            "list-mcp-server-status",
            "list-skills-for-host",
          ];
          const missing = markers.filter((marker) => !source.includes(marker));
          return passIf(missing.length === 0, { missing });
        },
      },
    ],
  },
  {
    id: "connections",
    name: "Connections",
    route: "/settings/connections",
    checks: [
      {
        id: "connections-route-refresh",
        description: "Connections deep link serves the webview shell with an initial route",
        run: async (context) => {
          const response = await context.getText("/settings/connections");
          return passIf(
            response.status === 200 &&
              response.text.includes('/__codex/web-mode-bootstrap.js') &&
              response.text.includes('content="/settings/connections"'),
            {
              status: response.status,
              has_initial_route: response.text.includes('content="/settings/connections"'),
            },
          );
        },
      },
      {
        id: "aip-connectors",
        description: "Connections can read connector catalog through authenticated /aip",
        hostCalls: ["GET /aip/connectors"],
        run: async (context) => {
          const response = await context.getJson("/aip/connectors", { token: true });
          return passIf(response.status === 200 && Array.isArray(response.body?.data), {
            status: response.status,
            count: Array.isArray(response.body?.data) ? response.body.data.length : null,
            keys: objectKeys(response.body),
          });
        },
      },
      {
        id: "remote-control-clients",
        description: "Connections remote-control client list has an explicit backend contract",
        hostCalls: ["GET /wham/remote/control/clients?limit=100"],
        run: async (context) => {
          const response = await context.getJson("/wham/remote/control/clients?limit=100", { token: false });
          const hasTypedStatus = ["available", "degraded", "unavailable"].includes(response.body?.status);
          return passIf(
            response.status === 200 && (hasTypedStatus || Array.isArray(response.body?.data) || Array.isArray(response.body?.clients)),
            {
            status: response.status,
            contract_status: response.body?.status ?? null,
            keys: objectKeys(response.body),
            },
          );
        },
      },
    ],
  },
  {
    id: "plugins",
    name: "Plugins Manage",
    route: "/plugins",
    checks: [
      {
        id: "plugin-list",
        description: "plugin list includes Linux bundled plugins",
        hostCalls: ["appServer.rpc:plugin/list"],
        run: async (context) => {
          const result = await context.bridgeRpc("plugin/list", {});
          const plugins = flattenPlugins(result);
          const names = new Set(plugins.map((plugin) => plugin.name ?? plugin.id ?? plugin.interface?.displayName));
          return passIf(names.has("chrome") && names.has("computer-use"), {
            names: Array.from(names).sort(),
          });
        },
      },
      {
        id: "plugin-logos",
        description: "bootstrap rewrites desktop-local plugin image paths through the authenticated resource proxy",
        hostCalls: ["appServer.rpc:plugin/list", "bootstrap:rewriteLocalAssetUrls", "GET /__codex/local-file"],
        run: async (context) => {
          const result = await context.bridgeRpc("plugin/list", {});
          const source = await context.bootstrapSource();
          const plugins = flattenPlugins(result);
          const logos = plugins
            .flatMap((plugin) => [plugin.interface?.logo, plugin.interface?.composerIcon])
            .filter((value) => typeof value === "string");
          const localFileLogos = logos.filter((logo) => logo.includes("/__codex/local-file?"));
          const hasBootstrapRewrite =
            source.includes("rewriteLocalAssetUrls") &&
            source.includes("appServerAssetUrlMethods") &&
            source.includes("/__codex/local-file");
          return passIf(hasBootstrapRewrite && logos.length > 0, {
            logo_count: logos.length,
            proxied_logo_count: localFileLogos.length,
            bootstrap_rewrite: hasBootstrapRewrite,
          });
        },
      },
    ],
  },
  {
    id: "apps-connectors",
    name: "Apps And Connectors",
    route: "/settings/connections",
    checks: [
      {
        id: "app-list",
        description: "desktop list-apps host call maps to app/list",
        hostCalls: ["appServer.rpc:app/list"],
        run: async (context) => {
          const result = await context.bridgeRpc("app/list", { limit: 10 });
          return passIf(Array.isArray(result?.data), {
            count: Array.isArray(result?.data) ? result.data.length : null,
            keys: objectKeys(result),
          });
        },
      },
      {
        id: "connector-detail-and-logo",
        description: "connector detail and logo endpoints are backed by app/list data",
        hostCalls: ["GET /aip/connectors/:id", "GET /aip/connectors/:id/logo"],
        run: async (context) => {
          const list = await context.getJson("/aip/connectors", { token: true });
          const connector = list.body?.data?.[0];
          if (!connector?.id) {
            return {
              status: "unknown",
              evidence: { reason: "connector catalog empty", list_status: list.status },
            };
          }
          const detail = await context.getJson(`/aip/connectors/${encodeURIComponent(connector.id)}`, { token: true });
          const logo = await context.getJson(`/aip/connectors/${encodeURIComponent(connector.id)}/logo?theme=light`, {
            token: true,
          });
          return passIf(detail.status === 200 && logo.status === 200 && logo.body?.body?.base64, {
            connector_id: connector.id,
            detail_status: detail.status,
            logo_status: logo.status,
            logo_content_type: logo.body?.body?.contentType ?? null,
          });
        },
      },
    ],
  },
  {
    id: "chrome",
    name: "Chrome Plugin Browser Use",
    route: "/plugins",
    checks: [
      {
        id: "chrome-plugin-present",
        description: "Chrome plugin is installed or installable in web mode",
        hostCalls: ["appServer.rpc:plugin/list"],
        run: async (context) => {
          const result = await context.bridgeRpc("plugin/list", {});
          const chrome = flattenPlugins(result).find((plugin) => plugin.name === "chrome" || plugin.id === "chrome");
          return passIf(Boolean(chrome), { found: Boolean(chrome), plugin: summarizePlugin(chrome) });
        },
      },
      {
        id: "browser-status",
        description: "Browser Use status is explicit for desktop, container, or disabled runtime",
        hostCalls: ["GET /__codex/browser/status"],
        run: async (context) => {
          const response = await context.getJson("/__codex/browser/status", { token: true });
          return passIf(response.status === 200 && typeof response.body?.mode === "string", {
            status: response.status,
            mode: response.body?.mode,
            reason: response.body?.reason ?? null,
          });
        },
      },
    ],
  },
  {
    id: "computer-use",
    name: "Computer Use",
    route: "/settings/computer-use",
    checks: [
      {
        id: "computer-plugin-present",
        description: "Computer Use bundled plugin is visible in web mode",
        hostCalls: ["appServer.rpc:plugin/list"],
        run: async (context) => {
          const result = await context.bridgeRpc("plugin/list", {});
          const plugin = flattenPlugins(result).find((item) => item.name === "computer-use" || item.id === "computer-use");
          return passIf(Boolean(plugin), { found: Boolean(plugin), plugin: summarizePlugin(plugin) });
        },
      },
      {
        id: "honest-computer-mode",
        description: "health tells the UI whether physical desktop control is really available",
        run: async (context) => {
          const health = context.health ?? (await context.getJson("/__codex/health", { token: false })).body;
          return passIf(typeof health?.computer_use?.mode === "string" && typeof health?.computer_use?.physical_host_control === "boolean", {
            mode: health?.computer_use?.mode ?? null,
            physical_host_control: health?.computer_use?.physical_host_control ?? null,
          });
        },
      },
    ],
  },
  {
    id: "mic-realtime",
    name: "Microphone And Realtime",
    route: "/",
    checks: [
      {
        id: "voice-capabilities",
        description: "bootstrap augments model provider capabilities through an explicit voice contract",
        hostCalls: ["appServer.rpc:modelProvider/capabilities/read", "bootstrap:voice-capability-augmentation"],
        run: async (context) => {
          const result = await context.bridgeRpc("modelProvider/capabilities/read", {});
          const source = await context.bootstrapSource();
          const hasBootstrapVoiceContract = source.includes("realtimeVoice: true") && source.includes("voiceInput: true");
          return passIf((result?.realtimeVoice === true && result?.voiceInput === true) || hasBootstrapVoiceContract, {
            realtimeVoice: result?.realtimeVoice ?? null,
            voiceInput: result?.voiceInput ?? null,
            bootstrap_voice_contract: hasBootstrapVoiceContract,
          });
        },
      },
      {
        id: "dictation-bridge",
        description: "global dictation host methods are typed fallbacks in browser mode",
        run: async (context) => {
          const source = await context.bootstrapSource();
          const markers = ["global-dictation-history", "global-dictation-copy-history-item", "electron-request-microphone-permission"];
          const missing = markers.filter((marker) => !source.includes(marker));
          return passIf(missing.length === 0, { missing });
        },
      },
    ],
  },
  {
    id: "refresh-persistence",
    name: "Refresh Persistence",
    route: "/settings/connections",
    checks: [
      {
        id: "known-routes-preserve-state",
        description: "direct refresh for key SPA routes preserves route metadata",
        run: async (context) => {
          const routes = ["/", "/plugins", "/settings", "/settings/connections", "/settings/computer-use"];
          const results = [];
          for (const route of routes) {
            const response = await context.getText(route);
            results.push({
              route,
              status: response.status,
              has_bootstrap: response.text.includes("/__codex/web-mode-bootstrap.js"),
              has_initial_route: route === "/" ? true : response.text.includes('name="initial-route"'),
            });
          }
          return passIf(results.every((result) => result.status === 200 && result.has_bootstrap && result.has_initial_route), {
            results,
          });
        },
      },
    ],
  },
  {
    id: "stop-cancel",
    name: "Stop And Cancel",
    route: "/",
    checks: [
      {
        id: "conversation-interrupt",
        description: "stop button can call an explicit interrupt endpoint and receive a typed result",
        hostCalls: ["bridge:conversation.interrupt", "appServer.rpc:turn/interrupt"],
        run: async (context) => {
          const response = await context.postJson(
            "/__codex/bridge",
            { method: "conversation.interrupt", params: { conversationId: "fixture-thread" } },
            { token: true },
          );
          return passIf(response.status === 200 && response.body?.ok === true && typeof response.body?.result === "object", {
            status: response.status,
            result: response.body?.result ?? null,
          });
        },
      },
    ],
  },
];

function usage() {
  console.error(`Usage:
  web-mode-contract-harness.mjs --base-url http://127.0.0.1:3773/ [--out ${DEFAULT_OUT}] [--allow-failures]
  web-mode-contract-harness.mjs --fixture [--out ${DEFAULT_OUT}]
`);
}

function parseArgs(argv) {
  const args = {
    baseUrl: null,
    out: DEFAULT_OUT,
    fixture: false,
    allowFailures: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--base-url") {
      args.baseUrl = argv[++index] ?? null;
    } else if (arg === "--out") {
      args.out = argv[++index] ?? null;
    } else if (arg === "--fixture") {
      args.fixture = true;
    } else if (arg === "--allow-failures") {
      args.allowFailures = true;
    } else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.fixture && !args.baseUrl) {
    usage();
    process.exit(64);
  }
  return args;
}

function passIf(condition, evidence = {}) {
  return {
    status: condition ? "pass" : "fail",
    evidence,
  };
}

function objectKeys(value) {
  return value && typeof value === "object" ? Object.keys(value).sort() : [];
}

function flattenPlugins(result) {
  if (Array.isArray(result?.plugins)) {
    return result.plugins;
  }
  if (Array.isArray(result?.data)) {
    return result.data;
  }
  if (Array.isArray(result?.marketplaces)) {
    return result.marketplaces.flatMap((marketplace) => (Array.isArray(marketplace.plugins) ? marketplace.plugins : []));
  }
  return [];
}

function summarizePlugin(plugin) {
  if (!plugin || typeof plugin !== "object") {
    return null;
  }
  return {
    id: plugin.id ?? null,
    name: plugin.name ?? null,
    displayName: plugin.interface?.displayName ?? plugin.displayName ?? null,
    installation: plugin.installation ?? null,
  };
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function responseBody(response, mode) {
  const text = await response.text();
  if (mode === "text") {
    return { text };
  }
  try {
    return { body: text.length > 0 ? JSON.parse(text) : null, text };
  } catch {
    return { body: null, text };
  }
}

class HarnessContext {
  constructor(baseUrl) {
    this.baseUrl = new URL(baseUrl);
    this.token = null;
    this.health = null;
    this._bootstrapSource = null;
  }

  absoluteUrl(route) {
    return new URL(route, this.baseUrl).toString();
  }

  async bootstrapSource() {
    if (this._bootstrapSource == null) {
      const response = await this.getText("/__codex/web-mode-bootstrap.js");
      this._bootstrapSource = response.text;
    }
    return this._bootstrapSource;
  }

  async ensureToken() {
    if (this.token != null) {
      return this.token;
    }
    const source = await this.bootstrapSource();
    const match = source.match(/window\.__CODEX_WEB_TOKEN__\s*=\s*("(?:(?:\\.)|[^"])*")/);
    if (!match) {
      throw new Error("bootstrap did not expose window.__CODEX_WEB_TOKEN__");
    }
    this.token = JSON.parse(match[1]);
    return this.token;
  }

  async request(route, { method = "GET", body = null, token = false, mode = "json" } = {}) {
    const headers = {};
    if (token) {
      headers["x-codex-web-token"] = await this.ensureToken();
    }
    if (body != null) {
      headers["content-type"] = "application/json";
    }
    const response = await fetchWithTimeout(this.absoluteUrl(route), {
      method,
      headers,
      body: body == null ? undefined : JSON.stringify(body),
    });
    const parsed = await responseBody(response, mode);
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      ...parsed,
    };
  }

  async getJson(route, options = {}) {
    return await this.request(route, { ...options, mode: "json" });
  }

  async getText(route, options = {}) {
    return await this.request(route, { ...options, mode: "text" });
  }

  async postJson(route, body, options = {}) {
    return await this.request(route, { ...options, method: "POST", body, mode: "json" });
  }

  async bridgeRpc(method, params) {
    const response = await this.postJson(
      "/__codex/bridge",
      { method: "appServer.rpc", params: { method, params } },
      { token: true },
    );
    if (response.status !== 200 || response.body?.ok !== true) {
      throw new Error(`bridge rpc ${method} failed: HTTP ${response.status} ${JSON.stringify(response.body)}`);
    }
    return response.body.result;
  }
}

async function runCheck(context, check) {
  try {
    const result = await check.run(context);
    return {
      id: check.id,
      description: check.description,
      host_calls: check.hostCalls ?? [],
      status: result.status,
      evidence: result.evidence ?? {},
    };
  } catch (error) {
    return {
      id: check.id,
      description: check.description,
      host_calls: check.hostCalls ?? [],
      status: "fail",
      evidence: {
        error: error.message,
      },
    };
  }
}

async function runHarness(baseUrl) {
  const context = new HarnessContext(baseUrl);
  const screens = [];

  for (const screen of SCREEN_CONTRACTS) {
    const checks = [];
    for (const check of screen.checks) {
      checks.push(await runCheck(context, check));
    }
    screens.push({
      id: screen.id,
      name: screen.name,
      route: screen.route,
      checks,
      status: aggregateStatus(checks),
    });
  }

  const summary = summarizeScreens(screens);
  return {
    schema_version: 1,
    generated_at: new Date(0).toISOString(),
    base_url: new URL(baseUrl).toString(),
    summary,
    runtime: {
      mode: context.health?.mode ?? null,
      diagnostics: context.health?.diagnostics ?? null,
      browser_use: context.health?.browser_use ?? null,
      computer_use: context.health?.computer_use ?? null,
      chrome_native_host: context.health?.chrome_native_host ?? null,
      app_server: context.health?.app_server ?? null,
    },
    screens,
  };
}

function aggregateStatus(checks) {
  if (checks.some((check) => check.status === "fail")) {
    return "fail";
  }
  if (checks.some((check) => check.status === "unknown")) {
    return "unknown";
  }
  return "pass";
}

function summarizeScreens(screens) {
  const checks = screens.flatMap((screen) => screen.checks);
  const counts = {
    pass: checks.filter((check) => check.status === "pass").length,
    fail: checks.filter((check) => check.status === "fail").length,
    unknown: checks.filter((check) => check.status === "unknown").length,
  };
  return {
    status: counts.fail > 0 ? "fail" : counts.unknown > 0 ? "unknown" : "pass",
    checks: counts,
    failing_screens: screens.filter((screen) => screen.status === "fail").map((screen) => screen.id),
  };
}

async function writeMatrix(outPath, matrix) {
  const resolved = path.resolve(outPath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, `${JSON.stringify(matrix, null, 2)}\n`);
}

function fixtureJson(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(`${JSON.stringify(body)}\n`);
}

function fixtureText(response, status, body, contentType = "text/plain; charset=utf-8") {
  response.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
  });
  response.end(body);
}

async function readFixtureBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return null;
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function fixtureAuthorized(request, response, url) {
  if (request.headers["x-codex-web-token"] === "fixture-token" || url.searchParams.get("codex_web_token") === "fixture-token") {
    return true;
  }
  fixtureJson(response, 401, { error: "missing_or_invalid_token" });
  return false;
}

function fixturePlugins() {
  return {
    marketplaces: [
      {
        plugins: [
          {
            name: "chrome",
            id: "chrome",
            installation: "INSTALLED",
            interface: {
              displayName: "Chrome",
              logo: "http://127.0.0.1/assets/chrome.png",
            },
          },
          {
            name: "computer-use",
            id: "computer-use",
            installation: "INSTALLED",
            interface: {
              displayName: "Computer Use",
              logo: "http://127.0.0.1/assets/computer-use.png",
            },
          },
        ],
      },
    ],
  };
}

function fixtureAppList() {
  return {
    data: [
      {
        id: "github",
        name: "GitHub",
        installUrl: "https://chatgpt.com/gpts",
        actions: [],
      },
    ],
    nextCursor: null,
  };
}

async function startFixtureServer() {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/__codex/health") {
      fixtureJson(response, 200, {
        package: "codex-desktop-linux",
        mode: "devcontainer-web",
        pid: process.pid,
        diagnostics: {
          status: "ok",
          capabilities: {
            app_server_bridge: "stdio",
            browser_sidecar: "container-chromium",
            computer_use_mode: "browser-only",
            chrome_native_host: "installed",
          },
        },
        app_server: { status: "running", initialized: true },
        browser_use: { mode: "container-chromium", reason: null },
        chrome_native_host: { status: "installed" },
        computer_use: { mode: "browser-only", physical_host_control: false },
      });
      return;
    }
    if (url.pathname === "/__codex/web-mode-bootstrap.js") {
      fixtureText(
        response,
        200,
        [
          'window.__CODEX_WEB_TOKEN__ = "fixture-token";',
          '"hotkey-window-hotkey-state";',
          '"batch-write-config-value-for-host";',
          '"list-mcp-server-status";',
          '"list-skills-for-host";',
          '"rewriteLocalAssetUrls";',
          '"appServerAssetUrlMethods";',
          '"/__codex/local-file";',
          '"global-dictation-history";',
          '"global-dictation-copy-history-item";',
          '"electron-request-microphone-permission";',
        ].join("\n"),
        "text/javascript; charset=utf-8",
      );
      return;
    }
    if (url.pathname === "/__codex/bridge") {
      if (!fixtureAuthorized(request, response, url)) {
        return;
      }
      const body = await readFixtureBody(request);
      if (body?.method === "health.read") {
        fixtureJson(response, 200, { ok: true, result: { package: "codex-desktop-linux" } });
        return;
      }
      if (body?.method === "conversation.interrupt") {
        fixtureJson(response, 200, { ok: true, result: { interrupted: false, reason: "no-active-turn" } });
        return;
      }
      if (body?.method === "appServer.rpc") {
        const rpcMethod = body.params?.method;
        if (rpcMethod === "thread/list") {
          fixtureJson(response, 200, { ok: true, result: { items: [] } });
          return;
        }
        if (rpcMethod === "plugin/list") {
          fixtureJson(response, 200, { ok: true, result: fixturePlugins() });
          return;
        }
        if (rpcMethod === "app/list") {
          fixtureJson(response, 200, { ok: true, result: fixtureAppList() });
          return;
        }
        if (rpcMethod === "modelProvider/capabilities/read") {
          fixtureJson(response, 200, { ok: true, result: { realtimeVoice: true, voiceInput: true } });
          return;
        }
      }
      fixtureJson(response, 200, { ok: true, result: {} });
      return;
    }
    if (url.pathname === "/__codex/browser/status") {
      if (!fixtureAuthorized(request, response, url)) {
        return;
      }
      fixtureJson(response, 200, { mode: "container-chromium", reason: null });
      return;
    }
    if (url.pathname === "/aip/connectors") {
      if (!fixtureAuthorized(request, response, url)) {
        return;
      }
      fixtureJson(response, 200, fixtureAppList());
      return;
    }
    if (url.pathname === "/aip/connectors/github") {
      if (!fixtureAuthorized(request, response, url)) {
        return;
      }
      fixtureJson(response, 200, fixtureAppList().data[0]);
      return;
    }
    if (url.pathname === "/aip/connectors/github/logo") {
      if (!fixtureAuthorized(request, response, url)) {
        return;
      }
      fixtureJson(response, 200, {
        body: {
          contentType: "image/svg+xml",
          base64: Buffer.from("<svg/>").toString("base64"),
        },
      });
      return;
    }
    if (url.pathname === "/wham/remote/control/clients") {
      fixtureJson(response, 200, { status: "unavailable", clients: [], data: [] });
      return;
    }
    if (url.pathname === "/" || !path.extname(url.pathname)) {
      const routeTag = url.pathname === "/" ? "" : `<meta name="initial-route" content="${url.pathname}">`;
      fixtureText(
        response,
        200,
        `<!doctype html><html><head>${routeTag}<script src="/__codex/web-mode-bootstrap.js"></script></head><body></body></html>`,
        "text/html; charset=utf-8",
      );
      return;
    }
    fixtureText(response, 404, "Not found\n");
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}/`,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let fixture = null;
  try {
    if (args.fixture) {
      fixture = await startFixtureServer();
      args.baseUrl = fixture.baseUrl;
    }
    const matrix = await runHarness(args.baseUrl);
    await writeMatrix(args.out, matrix);
    process.stdout.write(`${JSON.stringify(matrix.summary, null, 2)}\n`);
    if (matrix.summary.status === "fail" && !args.allowFailures) {
      process.exitCode = 1;
    }
  } finally {
    await fixture?.close();
  }
}

main().catch((error) => {
  console.error(`web-mode contract harness failed: ${error.message}`);
  process.exit(1);
});
