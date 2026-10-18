import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { io } from "socket.io-client";
import * as Y from "yjs";
import { replaceSharedText } from "../src/shared-text.js";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const backendEntry = path.join(projectRoot, "backend", "index.js");

const getFreePort = async () => new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close((error) => error ? reject(error) : resolve(port));
  });
});

const startBackend = async (port, databasePath) => {
  const child = spawn(process.execPath, [backendEntry], {
    cwd: projectRoot,
    env: { ...process.env, PORT: String(port), DATABASE_PATH: databasePath },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await new Promise((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error(`Backend did not start: ${output}`)), 5000);
      const finish = (callback, value) => {
        clearTimeout(timer);
        callback(value);
      };

      child.stdout.on("data", (chunk) => {
        output += chunk.toString();
        if (output.includes(`server listening on port ${port}`)) finish(resolve);
      });
      child.stderr.on("data", (chunk) => {
        output += chunk.toString();
      });
      child.once("error", (error) => finish(reject, error));
      child.once("exit", (code) => {
        finish(reject, new Error(`Backend exited with code ${code}: ${output}`));
      });
    });
    return child;
  } catch (error) {
    child.kill();
    throw error;
  }
};

const stopBackend = async (child) => {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
};

const connectClient = async (url) => {
  const client = io(url, {
    reconnection: false,
    timeout: 5000,
    transports: ["websocket"],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Socket connection timed out")), 5000);
    client.once("connect", () => {
      clearTimeout(timer);
      resolve();
    });
    client.once("connect_error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return client;
};

const nextEvent = (client, eventName) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    client.off(eventName, onEvent);
    reject(new Error(`Timed out waiting for ${eventName}`));
  }, 5000);
  const onEvent = (...args) => {
    clearTimeout(timer);
    resolve(args.length === 1 ? args[0] : args);
  };
  client.once(eventName, onEvent);
});

const joinRoom = async (client, roomId, userName) => {
  const documentState = nextEvent(client, "documentState");
  const response = new Promise((resolve) => {
    client.emit("join", { roomId, userName }, resolve);
  });
  const [update, acknowledgement] = await Promise.all([documentState, response]);
  assert.equal(acknowledgement?.ok, true);

  const document = new Y.Doc();
  Y.applyUpdate(document, update);
  return document;
};

test("collaboration broadcasts edits and cursors, then restores saved content", {
  timeout: 25000,
}, async () => {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "collaborative-editor-test-"));
  const databasePath = path.join(temporaryDirectory, "editor.sqlite");
  const port = await getFreePort();
  const serverUrl = `http://127.0.0.1:${port}`;
  let backend;
  let firstClient;
  let secondClient;
  let restoredClient;

  try {
    backend = await startBackend(port, databasePath);
    firstClient = await connectClient(serverUrl);
    secondClient = await connectClient(serverUrl);

    const firstDocument = await joinRoom(firstClient, "integration-room", "Ada");
    const duplicateNamePresence = nextEvent(firstClient, "userJoined");
    const secondDocument = await joinRoom(secondClient, "integration-room", "Ada");
    assert.deepEqual(await duplicateNamePresence, [
      { socketId: firstClient.id, userName: "Ada" },
      { socketId: secondClient.id, userName: "Ada" },
    ]);

    replaceSharedText(firstDocument, "title", "Integration notes");
    replaceSharedText(firstDocument, "source", "Shared body");
    const remoteUpdate = nextEvent(secondClient, "documentUpdate");
    const writeAcknowledgement = new Promise((resolve) => {
      firstClient.emit("documentUpdate", {
        update: Y.encodeStateAsUpdate(firstDocument),
      }, resolve);
    });
    const [update, acknowledgement] = await Promise.all([remoteUpdate, writeAcknowledgement]);
    assert.equal(acknowledgement?.ok, true);
    Y.applyUpdate(secondDocument, update);
    assert.equal(secondDocument.getText("title").toString(), "Integration notes");
    assert.equal(secondDocument.getText("source").toString(), "Shared body");

    const source = firstDocument.getText("source");
    const cursorUpdate = nextEvent(secondClient, "cursorUpdate");
    firstClient.emit("cursorUpdate", {
      anchor: Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(source, 0)),
      head: Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(source, 6)),
    });
    const cursor = await cursorUpdate;
    assert.equal(cursor.userName, "Ada");
    assert.equal(cursor.socketId, firstClient.id);

    const cursorLeft = nextEvent(secondClient, "cursorLeft");
    const remainingPresence = nextEvent(secondClient, "userJoined");
    firstClient.disconnect();
    firstClient = null;
    assert.equal(await cursorLeft, cursor.socketId);
    assert.deepEqual(await remainingPresence, [
      { socketId: secondClient.id, userName: "Ada" },
    ]);

    secondClient.disconnect();
    secondClient = null;
    await stopBackend(backend);
    backend = await startBackend(port, databasePath);

    restoredClient = await connectClient(serverUrl);
    const restoredDocument = await joinRoom(restoredClient, "integration-room", "Sam");
    assert.equal(restoredDocument.getText("title").toString(), "Integration notes");
    assert.equal(restoredDocument.getText("source").toString(), "Shared body");
  } finally {
    firstClient?.disconnect();
    secondClient?.disconnect();
    restoredClient?.disconnect();
    await stopBackend(backend);
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
