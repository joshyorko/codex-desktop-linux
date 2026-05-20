#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawnSync } from "node:child_process";

const API_BASE = process.env.CODEX_REMOTE_CONTROL_API_BASE || "https://chatgpt.com/backend-api";
const ORIGINATOR = "Codex Desktop Linux remote-control hosts";
const ESC = "\x1b[";
const HIDE = `${ESC}?25l`;
const SHOW = `${ESC}?25h`;
const ALT_ON = `${ESC}?1049h`;
const ALT_OFF = `${ESC}?1049l`;
const MOUSE_ON = `${ESC}?1000h${ESC}?1006h`;
const MOUSE_OFF = `${ESC}?1000l${ESC}?1006l`;

const palette = {
  ink: "\x1b[38;5;252m",
  dim: "\x1b[38;5;244m",
  faint: "\x1b[38;5;238m",
  blue: "\x1b[38;5;81m",
  cyan: "\x1b[38;5;45m",
  green: "\x1b[38;5;114m",
  yellow: "\x1b[38;5;221m",
  red: "\x1b[38;5;203m",
  magenta: "\x1b[38;5;207m",
  violet: "\x1b[38;5;141m",
  white: "\x1b[38;5;255m",
  bgDeep: "\x1b[48;5;17m",
  bg: "\x1b[48;5;235m",
  bgSoft: "\x1b[48;5;236m",
  bgGlow: "\x1b[48;5;24m",
  row: "\x1b[48;5;236m",
  rowHot: "\x1b[48;5;31m",
  panel: "\x1b[48;5;234m",
  panelHot: "\x1b[48;5;17m",
  reset: "\x1b[0m",
  bold: "\x1b[1m",
};

function usage() {
  console.log(`Usage: codex-desktop remote-control hosts [COMMAND] [OPTIONS]

Commands:
  tui                         Open the interactive host manager (default)
  list                        Print remote-control hosts
  delete ENV_ID --yes         Delete a host by environment id

Options:
  --codex-home DIR            Read auth.json from DIR (default: CODEX_HOME or ~/.codex)
  --json                      Print JSON for list output
  --include-online            Allow deleting online hosts in the manager
  -h, --help                  Show this help

Interactive controls:
  Mouse click                 Select rows and buttons
  Up/Down or k/j              Move selection
  d                           Delete selected host
  r                           Refresh
  f                           Toggle stale-only filter
  o                           Toggle online deletion lock
  c                           Copy env id when wl-copy/xclip/pbcopy exists
  q or Esc                    Quit`);
}

function parseArgs(argv) {
  const args = {
    command: "tui",
    codexHome: process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
    json: false,
    yes: false,
    includeOnline: false,
    envId: null,
  };
  const rest = [...argv];
  if (rest[0] && !rest[0].startsWith("-")) args.command = rest.shift();
  while (rest.length > 0) {
    const arg = rest.shift();
    switch (arg) {
      case "--codex-home":
        args.codexHome = rest.shift();
        if (!args.codexHome) throw new Error("--codex-home requires a directory");
        break;
      case "--json":
        args.json = true;
        break;
      case "--yes":
        args.yes = true;
        break;
      case "--include-online":
        args.includeOnline = true;
        break;
      case "-h":
      case "--help":
        args.command = "help";
        break;
      default:
        if (args.command === "delete" && args.envId == null && !arg.startsWith("-")) args.envId = arg;
        else throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

function authFromCodexHome(codexHome) {
  const authPath = path.join(codexHome, "auth.json");
  let auth;
  try {
    auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
  } catch (error) {
    throw new Error(`failed to read ${authPath}: ${error.message}`);
  }
  const accessToken = auth?.tokens?.access_token;
  const accountId = auth?.tokens?.account_id;
  if (!accessToken) throw new Error(`${authPath} does not contain tokens.access_token`);
  return { accessToken, accountId };
}

function apiHeaders(auth, extra = {}) {
  return {
    authorization: `Bearer ${auth.accessToken}`,
    ...(auth.accountId ? { "ChatGPT-Account-Id": auth.accountId } : {}),
    originator: ORIGINATOR,
    "user-agent": ORIGINATOR,
    ...extra,
  };
}

async function apiFetch(auth, apiPath, options = {}) {
  return await fetch(`${API_BASE}${apiPath}`, {
    ...options,
    headers: apiHeaders(auth, options.headers || {}),
    signal: AbortSignal.timeout(20000),
  });
}

async function listHosts(auth) {
  const response = await apiFetch(auth, "/codex/remote/control/environments?limit=100");
  const text = await response.text();
  if (!response.ok) throw new Error(`list failed (${response.status}): ${text.slice(0, 1000)}`);
  const body = JSON.parse(text);
  return Array.isArray(body.items) ? body.items : [];
}

async function deleteHost(auth, envId) {
  const response = await apiFetch(auth, `/codex/remote/control/environments/${encodeURIComponent(envId)}`, {
    method: "DELETE",
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`delete failed (${response.status}): ${text.slice(0, 1000)}`);
}

function hostSummary(host) {
  return {
    env_id: host.env_id,
    name: host.name,
    display_name: host.display_name,
    host_name: host.host_name,
    client_type: host.client_type,
    online: Boolean(host.online),
    busy: Boolean(host.busy),
    last_seen_at: host.last_seen_at ?? null,
    installation_id: host.installation_id ?? null,
    os: host.os ?? null,
    arch: host.arch ?? null,
    app_server_version: host.app_server_version ?? null,
  };
}

function visibleLength(value) {
  return String(value).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").length;
}

function fit(value, width) {
  const text = String(value ?? "");
  if (width <= 0) return "";
  if (visibleLength(text) <= width) return text + " ".repeat(width - visibleLength(text));
  const plain = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  return plain.slice(0, Math.max(0, width - 1)) + ">";
}

function strip(value) {
  return String(value ?? "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

function ageMs(value) {
  if (!value) return Infinity;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? Infinity : Date.now() - date.getTime();
}

function formatAge(value) {
  if (!value) return "never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function hostName(host) {
  return host.display_name || host.name || host.host_name || "(unnamed)";
}

function risk(host, allHosts = []) {
  const duplicateName = allHosts.filter((candidate) => hostName(candidate) === hostName(host)).length > 1;
  if (host.online) return duplicateName ? "duplicate live name" : "active";
  if (!host.last_seen_at) return "never checked in";
  if (ageMs(host.last_seen_at) > 7 * 24 * 60 * 60 * 1000) return "old offline";
  if (duplicateName) return "duplicate offline";
  if ((host.name || "").includes("devpod") || (host.host_name || "").includes("devpod")) return "devpod cleanup";
  return "offline";
}

function statusPill(host) {
  if (host.online) return `${palette.green}ONLINE${palette.reset}`;
  if (!host.last_seen_at) return `${palette.red}STALE${palette.reset}`;
  return `${palette.yellow}OFFLINE${palette.reset}`;
}

function line(x, y, text) {
  return `${ESC}${y};${x}H${text}`;
}

function fill(width, color = palette.bg) {
  return `${color}${" ".repeat(Math.max(0, width))}${palette.reset}`;
}

function box(x, y, w, h, title, color = palette.dim) {
  const top = `${color}╭${"─".repeat(Math.max(0, w - 2))}╮${palette.reset}`;
  const mid = `${color}│${palette.reset}${palette.panel}${" ".repeat(Math.max(0, w - 2))}${palette.reset}${color}│${palette.reset}`;
  const bottom = `${color}╰${"─".repeat(Math.max(0, w - 2))}╯${palette.reset}`;
  const rows = [line(x, y, top)];
  for (let i = 1; i < h - 1; i += 1) rows.push(line(x, y + i, mid));
  rows.push(line(x, y + h - 1, bottom));
  if (title) rows.push(line(x + 2, y, `${palette.bgDeep}${color} ${title} ${palette.reset}`));
  return rows.join("");
}

function badge(text, color = palette.blue) {
  return `${palette.bgSoft}${color} ${text} ${palette.reset}`;
}

function meter(label, value, color) {
  return `${palette.dim}${label} ${color}${value}${palette.reset}`;
}

function terminalSize() {
  return {
    width: Math.max(96, process.stdout.columns || 120),
    height: Math.max(28, process.stdout.rows || 36),
  };
}

function printList(hosts, json) {
  if (json) {
    console.log(JSON.stringify(hosts.map(hostSummary), null, 2));
    return;
  }
  if (hosts.length === 0) {
    console.log("No remote-control hosts found.");
    return;
  }
  hosts.forEach((host, index) => {
    const version = host.app_server_version ? ` ${host.app_server_version}` : "";
    console.log(`${String(index + 1).padStart(2, " ")}. ${hostName(host)}  ${host.online ? "online" : "offline"}  ${host.client_type || "unknown"}${version}  ${host.os || "unknown-os"}  last=${formatAge(host.last_seen_at)}`);
    console.log(`    env_id=${host.env_id}`);
  });
}

function copyToClipboard(value) {
  const candidates = [
    ["wl-copy"],
    ["xclip", "-selection", "clipboard"],
    ["pbcopy"],
  ];
  for (const command of candidates) {
    const result = spawnSync(command[0], command.slice(1), { input: value, stdio: ["pipe", "ignore", "ignore"] });
    if (result.status === 0) return true;
  }
  return false;
}

class HostManager {
  constructor(auth, options) {
    this.auth = auth;
    this.includeOnline = options.includeOnline;
    this.hosts = [];
    this.selected = 0;
    this.filter = "all";
    this.message = "Loading remote hosts...";
    this.pending = false;
    this.confirm = null;
    this.hotspots = [];
    this.tick = 0;
    this.interval = null;
  }

  get visibleHosts() {
    if (this.filter === "stale") return this.hosts.filter((host) => !host.online);
    return this.hosts;
  }

  selectedHost() {
    return this.visibleHosts[this.selected] ?? null;
  }

  async refresh(message = "Refreshed from OpenAI remote-control registry.") {
    this.pending = true;
    this.render();
    try {
      this.hosts = await listHosts(this.auth);
      this.selected = Math.min(this.selected, Math.max(0, this.visibleHosts.length - 1));
      this.message = message;
    } catch (error) {
      this.message = error instanceof Error ? error.message : String(error);
    } finally {
      this.pending = false;
      this.render();
    }
  }

  start() {
    process.stdout.write(`${ALT_ON}${HIDE}${MOUSE_ON}`);
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.on("keypress", (str, key) => {
      this.handleKey(str, key).catch((error) => {
        this.message = error instanceof Error ? error.message : String(error);
        this.render();
      });
    });
    process.stdin.on("data", (chunk) => this.handleMouse(chunk.toString("utf8")));
    process.stdout.on("resize", () => this.render());
    this.interval = setInterval(() => {
      if (this.pending) {
        this.tick += 1;
        this.render();
      }
    }, 120);
    this.refresh("Loaded hosts. Select a stale record and delete it when you are sure.");
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdout.write(`${MOUSE_OFF}${SHOW}${ALT_OFF}`);
    process.exit(0);
  }

  async handleKey(str, key) {
    if (this.confirm) return await this.handleConfirmKey(str, key);
    if (key.name === "q" || key.name === "escape" || (key.ctrl && key.name === "c")) this.stop();
    else if (key.name === "down" || key.name === "j") this.move(1);
    else if (key.name === "up" || key.name === "k") this.move(-1);
    else if (key.name === "r") await this.refresh();
    else if (key.name === "f") this.toggleFilter();
    else if (key.name === "o") this.toggleOnlineLock();
    else if (key.name === "c") this.copyEnvId();
    else if (key.name === "d" || key.name === "delete" || key.name === "return") this.beginDelete();
  }

  async handleConfirmKey(str, key) {
    if (key.name === "escape") {
      this.confirm = null;
      this.message = "Delete cancelled.";
      this.render();
      return;
    }
    if (key.name === "backspace") this.confirm.typed = this.confirm.typed.slice(0, -1);
    else if (key.name === "return") return await this.commitDelete();
    else if (str && /^[A-Za-z0-9_:.-]$/.test(str)) this.confirm.typed += str;
    this.render();
  }

  handleMouse(data) {
    const matches = [...data.matchAll(/\x1b\[<(\d+);(\d+);(\d+)([mM])/g)];
    for (const match of matches) {
      const button = Number(match[1]);
      const x = Number(match[2]);
      const y = Number(match[3]);
      const action = match[4];
      if (action !== "M" || button !== 0) continue;
      const hit = this.hotspots.find((spot) => x >= spot.x && x <= spot.x2 && y >= spot.y && y <= spot.y2);
      if (!hit) continue;
      if (hit.type === "row") {
        this.selected = hit.index;
        this.confirm = null;
        this.render();
      } else if (hit.type === "button") {
        this.handleButton(hit.action).catch((error) => {
          this.message = error instanceof Error ? error.message : String(error);
          this.render();
        });
      }
    }
  }

  async handleButton(action) {
    if (action === "refresh") await this.refresh();
    else if (action === "filter") this.toggleFilter();
    else if (action === "online") this.toggleOnlineLock();
    else if (action === "copy") this.copyEnvId();
    else if (action === "delete") this.beginDelete();
    else if (action === "quit") this.stop();
  }

  move(delta) {
    const count = this.visibleHosts.length;
    if (count === 0) return;
    this.selected = Math.max(0, Math.min(count - 1, this.selected + delta));
    this.message = "";
    this.render();
  }

  toggleFilter() {
    this.filter = this.filter === "all" ? "stale" : "all";
    this.selected = Math.min(this.selected, Math.max(0, this.visibleHosts.length - 1));
    this.message = this.filter === "stale" ? "Showing offline/stale hosts only." : "Showing every host record.";
    this.render();
  }

  toggleOnlineLock() {
    this.includeOnline = !this.includeOnline;
    this.message = this.includeOnline ? "Online deletion unlocked for this session." : "Online deletion locked.";
    this.render();
  }

  copyEnvId() {
    const host = this.selectedHost();
    if (!host) return;
    this.message = copyToClipboard(host.env_id) ? "Copied env id to clipboard." : `env id: ${host.env_id}`;
    this.render();
  }

  beginDelete() {
    const host = this.selectedHost();
    if (!host) return;
    if (host.online && !this.includeOnline) {
      this.message = "Online host protected. Press o to unlock online deletion for this session.";
      this.render();
      return;
    }
    this.confirm = { envId: host.env_id, typed: "" };
    this.message = "";
    this.render();
  }

  async commitDelete() {
    if (!this.confirm) return;
    const envId = this.confirm.envId;
    if (this.confirm.typed !== envId) {
      this.message = "Confirmation did not match. Delete cancelled.";
      this.confirm = null;
      this.render();
      return;
    }
    this.pending = true;
    this.message = `Deleting ${envId}...`;
    this.render();
    try {
      await deleteHost(this.auth, envId);
      this.confirm = null;
      await this.refresh(`Deleted ${envId}.`);
    } finally {
      this.pending = false;
    }
  }

  spinner() {
    return ["◐", "◓", "◑", "◒"][this.tick % 4];
  }

  button(text, action, x, y) {
    const body = ` ${text} `;
    const visual = `▰${body}▰`;
    this.hotspots.push({ type: "button", action, x, x2: x + strip(visual).length - 1, y, y2: y });
    return `${palette.bgSoft}${palette.blue}▰${palette.ink}${body}${palette.blue}▰${palette.reset}`;
  }

  render() {
    const { width, height } = terminalSize();
    const leftW = Math.max(58, Math.floor(width * 0.58));
    const rightX = leftW + 2;
    const rightW = width - rightX - 1;
    const listTop = 7;
    const listH = height - 11;
    const hosts = this.visibleHosts;
    const selectedHost = this.selectedHost();
    this.hotspots = [];

    let out = `${ESC}2J${ESC}H`;
    for (let y = 1; y <= height; y += 1) out += line(1, y, fill(width, palette.bg));
    out += line(1, 1, fill(width, palette.bgDeep));
    out += line(2, 1, `${palette.bgDeep}${palette.bold}${palette.cyan}Codex Host Control${palette.reset}${palette.bgDeep} ${palette.dim}remote-control registry${palette.reset}`);
    out += line(2, 2, `${palette.dim}Clean up stale hosts from the same OpenAI registry Android reads.${palette.reset}`);
    const syncText = this.pending ? `${palette.yellow}${this.spinner()} syncing${palette.reset}` : `${palette.green}● live${palette.reset}`;
    out += line(width - strip(syncText).length - 2, 1, `${palette.bgDeep}${syncText}${palette.reset}`);

    let bx = 2;
    out += line(bx, 4, this.button("refresh  r", "refresh", bx, 4)); bx += 15;
    out += line(bx, 4, this.button(this.filter === "stale" ? "show all  f" : "stale only  f", "filter", bx, 4)); bx += 18;
    out += line(bx, 4, this.button(this.includeOnline ? "lock live  o" : "unlock live  o", "online", bx, 4)); bx += 18;
    out += line(bx, 4, this.button("copy id  c", "copy", bx, 4)); bx += 15;
    out += line(bx, 4, this.button("delete  d", "delete", bx, 4)); bx += 14;
    out += line(bx, 4, this.button("quit q", "quit", bx, 4));

    out += box(2, 6, leftW - 2, listH + 2, ` Hosts ${hosts.length}/${this.hosts.length} `, palette.cyan);
    out += box(rightX, 6, rightW, listH + 2, " Selected Host ", palette.violet);
    out += line(4, 7, `${palette.panel}${palette.dim}${fit("Name", 22)}${fit("State", 12)}${fit("Client", 18)}${fit("Seen", 12)}Judgment${palette.reset}`);

    const rows = hosts.slice(0, listH);
    rows.forEach((host, index) => {
      const y = listTop + index + 1;
      const hot = index === this.selected;
      const rowBg = hot ? palette.rowHot : palette.row;
      this.hotspots.push({ type: "row", index, x: 3, x2: leftW - 2, y, y2: y });
      const name = fit(hostName(host), 22);
      const status = fit(statusPill(host), 12);
      const kind = fit(host.client_type || "unknown", 18);
      const last = fit(formatAge(host.last_seen_at), 12);
      const hint = fit(risk(host, this.hosts), Math.max(8, leftW - 70));
      const cursor = hot ? `${palette.white}› ${palette.reset}` : "  ";
      out += line(3, y, `${rowBg}${cursor}${hot ? palette.bold : ""}${name}${status}${palette.ink}${kind}${last}${palette.dim}${hint}${palette.reset}`);
    });
    if (hosts.length === 0) {
      out += line(4, listTop + 1, `${palette.dim}No hosts match this view.${palette.reset}`);
    }

    const stats = {
      online: this.hosts.filter((host) => host.online).length,
      offline: this.hosts.filter((host) => !host.online).length,
      stale: this.hosts.filter((host) => !host.online && !host.last_seen_at).length,
    };
    out += line(4, height - 3, `${meter("online", stats.online, palette.green)}  ${meter("offline", stats.offline, palette.yellow)}  ${meter("never-seen", stats.stale, palette.red)}  ${badge(this.includeOnline ? "live delete unlocked" : "live delete locked", this.includeOnline ? palette.yellow : palette.green)}  ${badge(this.filter === "stale" ? "stale view" : "all hosts", palette.blue)}`);

    if (selectedHost) {
      const hostRisk = risk(selectedHost, this.hosts);
      const titleColor = selectedHost.online ? palette.green : palette.yellow;
      out += line(rightX + 2, listTop, `${palette.panel}${titleColor}${palette.bold}${fit(hostName(selectedHost), Math.max(12, rightW - 20))}${palette.reset}${selectedHost.online ? badge("ONLINE", palette.green) : badge("OFFLINE", palette.yellow)}`);
      out += line(rightX + 2, listTop + 2, `${palette.dim}${fit("Decision", 12)}${palette.reset}${fit(selectedHost.online ? "Keep registered unless this live host is intentional cleanup." : "Cleanup candidate if the machine/container is gone.", rightW - 16)}`);
      out += line(rightX + 2, listTop + 3, `${palette.dim}${fit("Risk", 12)}${palette.reset}${palette.yellow}${fit(hostRisk, rightW - 16)}${palette.reset}`);
      out += line(rightX + 2, listTop + 5, `${palette.violet}${fit("Identity", rightW - 4)}${palette.reset}`);
      const detail = [
        ["Env ID", selectedHost.env_id],
        ["Install", selectedHost.installation_id || "none"],
      ];
      detail.forEach(([key, value], index) => {
        out += line(rightX + 2, listTop + 6 + index, `${palette.dim}${fit(key, 12)}${palette.reset}${fit(value, rightW - 16)}`);
      });
      const runtime = [
        ["Client", selectedHost.client_type || "unknown"],
        ["Version", selectedHost.app_server_version || "unknown"],
        ["OS", `${selectedHost.os || "unknown"} ${selectedHost.arch || ""}`.trim()],
        ["Last seen", selectedHost.last_seen_at || "never"],
      ];
      out += line(rightX + 2, listTop + 10, `${palette.violet}${fit("Runtime", rightW - 4)}${palette.reset}`);
      runtime.forEach(([key, value], index) => {
        out += line(rightX + 2, listTop + 11 + index, `${palette.dim}${fit(key, 12)}${palette.reset}${fit(value, rightW - 16)}`);
      });
    } else {
      out += line(rightX + 2, listTop, `${palette.dim}Select a host to inspect it.${palette.reset}`);
    }

    if (this.confirm) {
      const w = Math.min(width - 10, 92);
      const x = Math.floor((width - w) / 2);
      const y = Math.floor(height / 2) - 4;
      out += box(x, y, w, 9, " Confirm Delete ", palette.red);
      out += line(x + 2, y + 2, `${palette.red}This removes the host from the OpenAI remote-control registry.${palette.reset}`);
      out += line(x + 2, y + 3, `${palette.dim}Android and other clients stop seeing it after refresh.${palette.reset}`);
      out += line(x + 2, y + 5, `Type env id: ${palette.yellow}${fit(this.confirm.typed, w - 17)}${palette.reset}`);
      out += line(x + 2, y + 7, `${palette.dim}Enter confirms. Esc cancels.${palette.reset}`);
    }

    const msg = this.message || "Mouse works. Stale records are offline hosts, never-seen placeholders, duplicates, and dead containers.";
    out += line(2, height - 1, `${palette.bg}${fit(msg, width - 2)}${palette.reset}`);
    process.stdout.write(out);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "help") return usage();
  const auth = authFromCodexHome(args.codexHome);
  if (args.command === "list") {
    printList(await listHosts(auth), args.json);
  } else if (args.command === "delete") {
    if (!args.envId) throw new Error("delete requires ENV_ID");
    if (!args.yes) throw new Error("delete requires --yes");
    await deleteHost(auth, args.envId);
    console.log(`Deleted ${args.envId}`);
  } else if (args.command === "tui") {
    new HostManager(auth, args).start();
  } else {
    throw new Error(`unknown command: ${args.command}`);
  }
}

main().catch((error) => {
  try {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdout.write(`${MOUSE_OFF}${SHOW}${ALT_OFF}`);
  } catch {}
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
