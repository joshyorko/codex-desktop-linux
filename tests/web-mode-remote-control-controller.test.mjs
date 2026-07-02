#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoDir = path.resolve(path.dirname(__filename), "..");

function jwt(payload) {
  return [
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "",
  ].join(".");
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function waitForFile(filePath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fs.access(filePath, fsConstants.R_OK);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

async function bridge(url, token, method, params = {}) {
  const response = await fetch(`${url}__codex/bridge`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-codex-web-token": token,
    },
    body: JSON.stringify({
      method: "desktopHost.request",
      params: { method, params },
    }),
  });
  const body = await response.json();
  if (!response.ok || body.ok === false) {
    throw new Error(`${method} failed: ${body.error ?? response.status}`);
  }
  return body.result;
}

async function appServerRpc(url, token, method, params = {}) {
  const response = await fetch(`${url}__codex/bridge`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-codex-web-token": token,
    },
    body: JSON.stringify({
      method: "appServer.rpc",
      params: { method, params },
    }),
  });
  const body = await response.json();
  if (!response.ok || body.ok === false) {
    throw new Error(`${method} failed: ${body.error ?? response.status}`);
  }
  return body.result;
}

async function fileMetadata(url, token, params = {}) {
  const response = await fetch(`${url}__codex/bridge`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-codex-web-token": token,
    },
    body: JSON.stringify({
      method: "fs.metadata",
      params,
    }),
  });
  const body = await response.json();
  if (!response.ok || body.ok === false) {
    throw new Error(`fs.metadata failed: ${body.error ?? response.status}`);
  }
  return body.result;
}

function websocketAccept(key) {
  return crypto.createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
}

function encodeServerFrame(payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  if (body.length < 126) {
    return Buffer.concat([Buffer.from([0x81, body.length]), body]);
  }
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(body.length, 2);
  return Buffer.concat([header, body]);
}

function serverMessageChunks(envelope, chunkSize = 24) {
  const body = Buffer.from(JSON.stringify(envelope.message), "utf8");
  const chunks = [];
  for (let offset = 0; offset < body.length; offset += chunkSize) {
    chunks.push(body.subarray(offset, offset + chunkSize));
  }
  return chunks.map((chunk, segmentId) => ({
    ...envelope,
    type: "server_message_chunk",
    message: undefined,
    segment_id: segmentId,
    segment_count: chunks.length,
    message_size_bytes: body.length,
    message_chunk_base64: chunk.toString("base64"),
  }));
}

class WebSocketFrameReader {
  buffer = Buffer.alloc(0);

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages = [];
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < offset + 2) {
          break;
        }
        length = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this.buffer.length < offset + 8) {
          break;
        }
        const high = this.buffer.readUInt32BE(offset);
        const low = this.buffer.readUInt32BE(offset + 4);
        if (high !== 0) {
          throw new Error("test websocket frame too large");
        }
        length = low;
        offset += 8;
      }
      const masked = Boolean(second & 0x80);
      const maskOffset = offset;
      if (masked) {
        offset += 4;
      }
      if (this.buffer.length < offset + length) {
        break;
      }
      let payload = this.buffer.subarray(offset, offset + length);
      if (masked) {
        const mask = this.buffer.subarray(maskOffset, maskOffset + 4);
        payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
      }
      this.buffer = this.buffer.subarray(offset + length);
      if ((first & 0x0f) === 0x1) {
        messages.push(JSON.parse(payload.toString("utf8")));
      }
    }
    return messages;
  }
}

function challengeTarget(baseUrl, apiPath) {
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}/${apiPath.replace(/^\/+/, "")}`);
  return { target_origin: url.origin, target_path: url.pathname };
}

function tokenHash(token) {
  return crypto.createHash("sha256").update(token).digest("base64url");
}

function decodeSignedPayload(base64) {
  return JSON.parse(Buffer.from(base64, "base64").toString("utf8"));
}

async function startRemoteControlBackend() {
  const state = {
    clientId: "client_1",
    accountUserId: "acct_user_1",
    token: "remote-session-token-1",
    tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    scopes: ["remote_control_controller_websocket"],
    websocketHeaders: null,
    sawEnrollmentProof: false,
    sawWebsocketProof: false,
    sawInitialize: false,
    deletedEnvIds: new Set(),
  };

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    const requestBody = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    const baseUrl = `http://127.0.0.1:${server.address().port}/backend-api`;
    const send = (status, body) => {
      response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      response.end(`${JSON.stringify(body)}\n`);
    };

    if (request.method === "GET" && url.pathname === "/backend-api/codex/remote/control/environments") {
      send(200, {
        items: [
          {
            env_id: "env_1",
            display_name: "Fixture Remote",
            host_name: "fixture-remote",
            online: true,
            os: "linux",
            arch: "x64",
            app_server_version: "0.130.0",
          },
          {
            env_id: "env_2",
            display_name: "Offline Fixture",
            host_name: "offline-fixture",
            online: false,
            os: "linux",
            arch: "x64",
            app_server_version: "0.130.0",
          },
        ].filter((environment) => !state.deletedEnvIds.has(environment.env_id)),
      });
      return;
    }
    if (request.method === "DELETE" && url.pathname === "/backend-api/codex/remote/control/environments/env_2") {
      state.deletedEnvIds.add("env_2");
      send(200, { ok: true });
      return;
    }
    if (request.method === "POST" && url.pathname === "/backend-api/codex/remote/control/client/enroll/start") {
      send(200, {
        client_id: state.clientId,
        account_user_id: state.accountUserId,
        device_key_challenge: {
          type: "device_key_challenge",
          nonce: crypto.randomBytes(24).toString("base64url"),
          purpose: "remote_control_client_enrollment",
          audience: "remote_control_client_enrollment",
          challenge_id: "enroll_challenge_1",
          ...challengeTarget(baseUrl, "/codex/remote/control/client/enroll/finish"),
          account_user_id: state.accountUserId,
          client_id: state.clientId,
          challenge_token: "enroll-token",
          challenge_expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        },
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/backend-api/codex/remote/control/client/enroll/finish") {
      assert.equal(requestBody.client_id, state.clientId);
      assert.equal(requestBody.device_identity?.algorithm, "ecdsa_p256_sha256");
      assert.equal(requestBody.device_key_proof?.challenge_token, "enroll-token");
      const signedPayload = decodeSignedPayload(requestBody.device_key_proof?.signed_payload_base64);
      assert.equal(signedPayload.domain, "codex-device-key-sign-payload/v1");
      assert.equal(signedPayload.payload?.type, "remoteControlClientEnrollment");
      assert.equal(signedPayload.payload?.clientId, state.clientId);
      state.sawEnrollmentProof = true;
      send(200, {
        client_id: state.clientId,
        account_user_id: state.accountUserId,
        remote_control_token: state.token,
        expires_at: state.tokenExpiresAt,
        scopes: state.scopes,
      });
      return;
    }
    send(404, { error: "not_found" });
  });

  server.on("upgrade", (request, socket) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/backend-api/codex/remote/control/client") {
      socket.destroy();
      return;
    }
    state.websocketHeaders = request.headers;
    assert.equal(request.headers["x-codex-client-id"], state.clientId);
    assert.equal(request.headers["x-codex-protocol-version"], "3");
    assert.equal(request.headers["x-codex-client-session-token"], `Bearer ${state.token}`);
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${websocketAccept(request.headers["sec-websocket-key"])}`,
        "",
        "",
      ].join("\r\n"),
    );

    const baseUrl = `http://127.0.0.1:${server.address().port}/backend-api`;
    socket.write(
      encodeServerFrame({
        type: "device_key_challenge",
        nonce: crypto.randomBytes(24).toString("base64url"),
        purpose: "remote_control_client_websocket",
        audience: "remote_control_client_websocket",
        sessionId: "session_1",
        targetOrigin: new URL(baseUrl).origin,
        targetPath: "/backend-api/codex/remote/control/client",
        accountUserId: state.accountUserId,
        clientId: state.clientId,
        tokenSha256Base64url: tokenHash(state.token),
        tokenExpiresAt: Math.floor(Date.parse(state.tokenExpiresAt) / 1000),
        scopes: state.scopes,
      }),
    );

    const reader = new WebSocketFrameReader();
    socket.on("data", (chunk) => {
      for (const message of reader.push(chunk)) {
        if (message.type === "device_key_proof") {
          assert.equal(message.algorithm, "ecdsa_p256_sha256");
          assert.ok(message.keyId);
          assert.ok(message.signatureDerBase64);
          assert.ok(message.signedPayloadBase64);
          const signedPayload = decodeSignedPayload(message.signedPayloadBase64);
          assert.equal(signedPayload.domain, "codex-device-key-sign-payload/v1");
          assert.equal(signedPayload.payload?.type, "remoteControlClientConnection");
          assert.equal(signedPayload.payload?.tokenExpiresAt, Math.floor(Date.parse(state.tokenExpiresAt) / 1000));
          state.sawWebsocketProof = true;
          continue;
        }
        if (message.type !== "client_message") {
          continue;
        }
        const rpc = message.message;
        if (rpc.method === "initialize") {
          state.sawInitialize = true;
          socket.write(
            encodeServerFrame({
              type: "server_message",
              client_id: state.clientId,
              seq_id: 1,
              stream_id: message.stream_id,
              env_id: "env_1",
              message: {
                jsonrpc: "2.0",
                id: rpc.id,
                result: {
                  userAgent: "fixture-remote-app-server",
                  codexHome: "/home/remote/.codex",
                  platformFamily: "unix",
                  platformOs: "linux",
                },
              },
            }),
          );
        } else if (rpc.method === "fs/getMetadata") {
          const isFile = String(rpc.params?.path ?? "").endsWith("README.md");
          socket.write(
            encodeServerFrame({
              type: "server_message",
              client_id: state.clientId,
              seq_id: 2,
              stream_id: message.stream_id,
              env_id: "env_1",
              message: { jsonrpc: "2.0", id: rpc.id, result: { isDirectory: !isFile, isFile, isSymlink: false } },
            }),
          );
        } else if (rpc.method === "fs/readDirectory") {
          for (const chunk of serverMessageChunks({
            type: "server_message",
            client_id: state.clientId,
            seq_id: 3,
            stream_id: message.stream_id,
            env_id: "env_1",
            message: {
              jsonrpc: "2.0",
              id: rpc.id,
              result: {
                entries: [
                  { fileName: "src", isDirectory: true, isFile: false },
                  { fileName: "README.md", isDirectory: false, isFile: true },
                ],
              },
            },
          })) {
            socket.write(encodeServerFrame(chunk));
          }
        } else if (rpc.method === "fs/readFile") {
          socket.write(
            encodeServerFrame({
              type: "server_message",
              client_id: state.clientId,
              seq_id: 4,
              stream_id: message.stream_id,
              env_id: "env_1",
              message: {
                jsonrpc: "2.0",
                id: rpc.id,
                result: { content: "remote file contents", encoding: "utf8" },
              },
            }),
          );
        } else if (rpc.method === "thread/start") {
          assert.equal(rpc.params.hostId, undefined);
          socket.write(
            encodeServerFrame({
              type: "server_message",
              client_id: state.clientId,
              seq_id: 5,
              stream_id: message.stream_id,
              env_id: "env_1",
              message: {
                jsonrpc: "2.0",
                id: rpc.id,
                result: { thread: { id: "remote-thread-1", cwd: rpc.params.cwd } },
              },
            }),
          );
        }
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, state, baseUrl: `http://127.0.0.1:${server.address().port}/backend-api` };
}

async function writeFakeAppServerBin(binPath) {
  await fs.writeFile(
    binPath,
    `#!/usr/bin/env node
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.id != null && message.method === "initialize") {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          userAgent: "fake-local-app-server",
          codexHome: process.env.CODEX_HOME,
          platformFamily: "unix",
          platformOs: "linux"
        }
      }) + "\\n");
    }
  }
});
setInterval(() => {}, 1000);
`,
    { mode: 0o700 },
  );
}

async function main() {
  const tmp = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "codex-web-remote-test-"));
  const backend = await startRemoteControlBackend();
  let child = null;
  try {
    const appDir = path.join(tmp, "app");
    const workspace = path.join(tmp, "workspace");
    const profile = path.join(tmp, "profile");
    const codexHome = path.join(tmp, "codex-home");
    await fs.mkdir(path.join(appDir, ".codex-linux"), { recursive: true });
    await fs.mkdir(path.join(appDir, "content", "webview"), { recursive: true });
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(codexHome, { recursive: true });
    await fs.writeFile(path.join(appDir, ".codex-linux", "web-mode-bootstrap.js"), "window.__fixture = true;\n");
    await fs.writeFile(path.join(appDir, "content", "webview", "index.html"), "<!doctype html><title>fixture</title>\n");

    const now = Math.floor(Date.now() / 1000);
    await fs.writeFile(
      path.join(codexHome, "auth.json"),
      `${JSON.stringify(
        {
          tokens: {
            access_token: jwt({
              iat: now,
              exp: now + 3600,
              "https://api.openai.com/auth": {
                chatgpt_account_id: "acct_1",
                chatgpt_account_user_id: "acct_user_1",
              },
            }),
            account_id: "acct_1",
          },
        },
        null,
        2,
      )}\n`,
    );

    const fakeCodex = path.join(tmp, "fake-codex");
    await writeFakeAppServerBin(fakeCodex);
    const configHome = path.join(tmp, "home", ".config");
    const stepUpToken = jwt({
      iat: now,
      exp: now + 300,
      pwd_auth_time: now,
      scope: "codex.remote_control.enroll",
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_1",
        chatgpt_account_user_id: "acct_user_1",
      },
    });

    child = spawn(
      process.execPath,
      [
        path.join(repoDir, "launcher", "web-mode-server.mjs"),
        "serve",
        "--app-dir",
        appDir,
        "--workspace",
        workspace,
        "--profile",
        profile,
        "--codex-home",
        codexHome,
        "--port",
        "0",
        "--require-token",
      ],
      {
        cwd: workspace,
        env: {
          ...process.env,
          CODEX_API_BASE_URL: backend.baseUrl,
          CODEX_CLI_PATH: fakeCodex,
          CODEX_BROWSER_USE_BROWSER_COMMAND: path.join(tmp, "missing-browser"),
          CODEX_WEB_MODE_REMOTE_CONTROL_STEP_UP_TOKEN: stepUpToken,
          HOME: path.join(tmp, "home"),
          XDG_CONFIG_HOME: configHome,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const stderr = [];
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => stderr.push(chunk));

    const statePath = path.join(profile, "run", "serve.json");
    await waitForFile(statePath);
    const serveState = await readJson(statePath);
    const bootstrap = await (await fetch(`${serveState.url}__codex/web-mode-bootstrap.js`)).text();
    const token = /window\.__CODEX_WEB_TOKEN__ = "([^"]+)"/.exec(bootstrap)?.[1];
    assert.ok(token, "bridge token should be injected into bootstrap");

    const refresh = await bridge(serveState.url, token, "refresh-remote-control-connections");
    assert.equal(refresh.remoteControlConnections[0]?.hostId, "remote-control:env_1");
    assert.equal(
      refresh.remoteControlConnections.some((connection) => connection.hostId === "remote-control:env_2"),
      true,
    );

    await assert.rejects(
      () => bridge(serveState.url, token, "delete-remote-control-environment", { envId: "env_1" }),
      /Only offline remote control environments can be deleted/,
    );
    const deleted = await bridge(serveState.url, token, "delete-remote-control-environment", { envId: "env_2" });
    assert.equal(backend.state.deletedEnvIds.has("env_2"), true);
    assert.equal(
      deleted.remoteControlConnections.some((connection) => connection.hostId === "remote-control:env_2"),
      false,
    );

    const authorization = await bridge(serveState.url, token, "authorize-remote-control-connections");
    assert.equal(authorization.authorized, true);
    const electronGlobalState = await readJson(path.join(codexHome, ".codex-global-state.json"));
    assert.ok(electronGlobalState["electron-remote-control-client-enrollments"]);
    const deviceKeyStore = await readJson(path.join(configHome, "codex-desktop", "remote-control-device-keys-v1.json"));
    assert.equal(Object.keys(deviceKeyStore.keys ?? {}).length, 1);

    const connect = await bridge(serveState.url, token, "set-remote-connection-auto-connect", {
      hostId: "remote-control:env_1",
      autoConnect: true,
    });
    assert.equal(connect.state, "connected");

    const connectionState = await bridge(serveState.url, token, "app-server-connection-state", {
      hostId: "remote-control:env_1",
    });
    assert.equal(connectionState.state, "connected");

    const listing = await bridge(serveState.url, token, "remote-workspace-directory-entries", {
      hostId: "remote-control:env_1",
      directoryPath: "/tmp/project",
    });
    assert.deepEqual(
      listing.entries.map((entry) => [entry.name, entry.type]),
      [
        ["src", "directory"],
        ["README.md", "file"],
      ],
    );
    const metadata = await fileMetadata(serveState.url, token, {
      hostId: "remote-control:env_1",
      path: "/tmp/project/README.md",
    });
    assert.equal(metadata.path, "/tmp/project/README.md");
    assert.equal(metadata.isFile, true);

    const file = await appServerRpc(serveState.url, token, "fs/readFile", {
      hostId: "remote-control:env_1",
      path: "/tmp/project/README.md",
    });
    assert.equal(file.content, "remote file contents");

    const thread = await appServerRpc(serveState.url, token, "thread/start", {
      hostId: "remote-control:env_1",
      cwd: "/tmp/project",
    });
    assert.equal(thread.thread.id, "remote-thread-1");
    assert.equal(thread.thread.cwd, "/tmp/project");
    assert.equal(backend.state.sawEnrollmentProof, true);
    assert.equal(backend.state.sawWebsocketProof, true);
    assert.equal(backend.state.sawInitialize, true);
  } finally {
    if (child && child.exitCode == null && child.signalCode == null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    await new Promise((resolve) => backend.server.close(resolve));
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
