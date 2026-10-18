import express from "express";
import http from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";
import { mkdirSync } from "fs";
import Database from "better-sqlite3";
import * as Y from "yjs";

const app = express();

const server = http.createServer(app);
const allowedOrigins = process.env.CLIENT_ORIGIN
  ? process.env.CLIENT_ORIGIN.split(",").map((origin) => origin.trim())
  : ["http://localhost:5173", "http://127.0.0.1:5173"];

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
  },
});

const rooms = new Map();
const defaultDocumentContent = "";
const previousDefaultDocumentContents = [
  "Start writing your document here.",
  'print("Hi")',
];
const backendDirectory = path.dirname(fileURLToPath(import.meta.url));
const databasePath =
  process.env.DATABASE_PATH ||
  path.join(backendDirectory, "data", "editor.sqlite");
mkdirSync(path.dirname(databasePath), { recursive: true });

const database = new Database(databasePath);
database.pragma("journal_mode = WAL");
database.exec(`
  CREATE TABLE IF NOT EXISTS documents (
    room_id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT 'Untitled document',
    content TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);
const documentColumns = database.pragma("table_info(documents)");
if (!documentColumns.some((column) => column.name === "content")) {
  database.exec("ALTER TABLE documents ADD COLUMN content TEXT NOT NULL DEFAULT ''");
  if (documentColumns.some((column) => column.name === "code")) {
    database.exec("UPDATE documents SET content = code");
  }
}
if (!documentColumns.some((column) => column.name === "title")) {
  database.exec("ALTER TABLE documents ADD COLUMN title TEXT NOT NULL DEFAULT 'Untitled document'");
  database.exec("UPDATE documents SET title = room_id");
}
const removePreviousDefaultContent = database.prepare(`
  UPDATE documents
  SET content = substr(content, length(?) + 1)
  WHERE substr(content, 1, length(?)) = ?
`);
for (const previousDefaultContent of previousDefaultDocumentContents) {
  removePreviousDefaultContent.run(
    previousDefaultContent,
    previousDefaultContent,
    previousDefaultContent
  );
}
const getDocument = database.prepare(
  "SELECT title, content FROM documents WHERE room_id = ?"
);
const saveDocument = database.prepare(`
  INSERT INTO documents (room_id, title, content, updated_at)
  VALUES (?, ?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(room_id) DO UPDATE SET
    title = excluded.title,
    content = excluded.content,
    updated_at = CURRENT_TIMESTAMP
`);
const createRoom = (savedDocument, roomId) => {
  const doc = new Y.Doc();
  const title = doc.getText("title");
  const source = doc.getText("source");
  title.insert(0, savedDocument?.title || roomId);
  source.insert(0, savedDocument?.content || defaultDocumentContent);

  return {
    users: new Map(),
    cursors: new Map(),
    doc,
  };
};

io.on("connection", (socket) => {
  console.log("Connected", socket.id);

  let currentRoom = null;
  let currentUser = null;

  socket.on("join", (payload = {}, acknowledge) => {
    const roomId = typeof payload.roomId === "string" ? payload.roomId.trim() : "";
    const userName = typeof payload.userName === "string" ? payload.userName.trim() : "";

    if (!roomId || roomId.length > 128 || !userName || userName.length > 40) {
      acknowledge?.({
        error: "Enter a room name and username within the allowed length.",
      });
      return;
    }

    if (currentRoom) {
      socket.leave(currentRoom);
      const previousRoom = rooms.get(currentRoom);
      previousRoom?.users.delete(socket.id);
      previousRoom?.cursors.delete(socket.id);
      if (previousRoom) {
        io.to(currentRoom).emit("cursorLeft", socket.id);
        io.to(currentRoom).emit("userJoined", Array.from(previousRoom.users, ([socketId, name]) => ({
          socketId,
          userName: name,
        })));
      }
    }

    currentRoom = roomId;
    currentUser = userName;

    socket.join(roomId);

    if (!rooms.has(roomId)) {
      const savedDocument = getDocument.get(roomId);
      rooms.set(roomId, createRoom(savedDocument, roomId));
    }

    const room = rooms.get(roomId);
    room.users.set(socket.id, userName);

    socket.emit("documentState", Y.encodeStateAsUpdate(room.doc));
    socket.emit("cursorState", Array.from(room.cursors.values()));

    io.to(roomId).emit("userJoined", Array.from(room.users, ([socketId, name]) => ({
      socketId,
      userName: name,
    })));
    acknowledge?.({ ok: true });
  });

  socket.on("documentUpdate", (payload = {}, acknowledge) => {
    const room = currentRoom && rooms.get(currentRoom);
    if (
      !room ||
      !(payload.update instanceof Uint8Array) ||
      payload.update.byteLength > 750_000
    ) {
      acknowledge?.({ ok: false });
      return;
    }

    try {
      Y.applyUpdate(room.doc, payload.update);
    } catch {
      acknowledge?.({ ok: false });
      return;
    }

    saveDocument.run(
      currentRoom,
      room.doc.getText("title").toString(),
      room.doc.getText("source").toString()
    );
    acknowledge?.({ ok: true });
    socket.to(currentRoom).emit("documentUpdate", payload.update);
  });

  socket.on("typing", () => {
    if (currentRoom && currentUser) {
      socket.to(currentRoom).emit("userTyping", currentUser);
    }
  });

  socket.on("cursorUpdate", (payload = {}) => {
    const room = currentRoom && rooms.get(currentRoom);
    const anchor = payload.anchor;
    const head = payload.head;
    if (
      !room ||
      !(anchor instanceof Uint8Array) ||
      !(head instanceof Uint8Array) ||
      anchor.byteLength > 128 ||
      head.byteLength > 128
    ) {
      return;
    }

    const cursor = {
      socketId: socket.id,
      userName: currentUser,
      anchor,
      head,
    };
    room.cursors.set(socket.id, cursor);
    socket.to(currentRoom).emit("cursorUpdate", cursor);
  });

  const removePresence = () => {
    if (!currentRoom || !currentUser) return;

    const room = rooms.get(currentRoom);
    room?.users.delete(socket.id);
    room?.cursors.delete(socket.id);
    if (room) {
      io.to(currentRoom).emit("cursorLeft", socket.id);
      io.to(currentRoom).emit("userJoined", Array.from(room.users, ([socketId, name]) => ({
        socketId,
        userName: name,
      })));
    }
    socket.leave(currentRoom);
    currentRoom = null;
    currentUser = null;
  };

  socket.on("disconnect", () => {
    removePresence();
    console.log("Disconnected", socket.id);
  });

  socket.on("leaveRoom", removePresence);
});

const port = process.env.PORT || 5000;

const projectDirectory = path.resolve(backendDirectory, "..");

app.use(express.static(path.join(projectDirectory, "frontend", "dist")));

app.get("*", (req, res) => {
  res.sendFile(path.join(projectDirectory, "frontend", "dist", "index.html"));
});

server.listen(port, () => {
  console.log(`server listening on port ${port}`);
});
