import { useEffect, useRef, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import "./App.css";
import io from "socket.io-client";
import * as Y from "yjs";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { normalizeYjsUpdate, replaceSharedText } from "./shared-text.js";

const socketUrl =
  import.meta.env.VITE_SERVER_URL ||
  (import.meta.env.DEV ? "http://localhost:5000" : window.location.origin);
const socket = io(socketUrl);
const cursorColors = ["#d1495b", "#2878b5", "#2a9d8f", "#a568c5", "#c87900"];

const getCursorColor = (socketId) => {
  let hash = 0;
  for (const character of socketId) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return cursorColors[hash % cursorColors.length];
};

const normalizeRoomUsers = (participants) => {
  if (!Array.isArray(participants)) return [];

  return participants.flatMap((participant, index) => {
    const isLegacyEntry = typeof participant === "string";
    const name = isLegacyEntry ? participant : participant?.userName ?? participant?.name;
    if (typeof name !== "string" || !name.trim()) return [];

    const socketId = !isLegacyEntry && typeof participant.socketId === "string" && participant.socketId
      ? participant.socketId
      : `legacy-${index}`;
    return [{ socketId, userName: name.trim() }];
  });
};

const renderCursorOverlay = ({ content, cursors, sharedDoc, localSocketId, contentRef }) => {
  const source = sharedDoc?.getText("source");
  if (!source) return null;

  const resolvedCursors = cursors.flatMap((cursor) => {
    if (cursor.socketId === localSocketId) return [];

    try {
      const anchorBytes = normalizeYjsUpdate(cursor.anchor);
      const headBytes = normalizeYjsUpdate(cursor.head);
      if (!anchorBytes || !headBytes) return [];

      const anchor = Y.createAbsolutePositionFromRelativePosition(
        Y.decodeRelativePosition(anchorBytes),
        sharedDoc
      );
      const head = Y.createAbsolutePositionFromRelativePosition(
        Y.decodeRelativePosition(headBytes),
        sharedDoc
      );
      if (!anchor || !head || anchor.type !== source || head.type !== source) return [];

      const start = Math.min(anchor.index, head.index);
      const end = Math.max(anchor.index, head.index);
      return [{
        socketId: cursor.socketId,
        userName: cursor.userName,
        color: getCursorColor(cursor.socketId),
        start,
        end,
        head: head.index,
      }];
    } catch {
      return [];
    }
  });

  const boundaries = new Set([0, content.length]);
  for (const cursor of resolvedCursors) {
    boundaries.add(cursor.start);
    boundaries.add(cursor.end);
    boundaries.add(cursor.head);
  }
  const points = Array.from(boundaries).sort((left, right) => left - right);

  return (
    <div className="cursor-overlay" aria-hidden="true">
      <div className="cursor-overlay-content" ref={contentRef}>
        {points.map((point, index) => {
          const markers = resolvedCursors.filter((cursor) => cursor.head === point);
          const nextPoint = points[index + 1];
          const segment = nextPoint === undefined ? "" : content.slice(point, nextPoint);
          const selection = resolvedCursors.find(
            (cursor) => cursor.start < nextPoint && cursor.end > point
          );

          return (
            <span className="cursor-overlay-segment" key={point}>
              {markers.map((cursor) => (
                <span
                  className="remote-cursor"
                  key={cursor.socketId}
                  style={{ "--cursor-color": cursor.color }}
                >
                  <span className="remote-cursor-label">{cursor.userName}</span>
                </span>
              ))}
              {segment && (
                <span
                  style={selection ? { backgroundColor: `${selection.color}35` } : undefined}
                >
                  {segment}
                </span>
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
};

const App = () => {
  const [joined, setJoined] = useState(false);
  const [documentReady, setDocumentReady] = useState(false);
  const [roomId, setRoomId] = useState(
    () => new URLSearchParams(window.location.search).get("room") || ""
  );
  const [userName, setUserName] = useState("");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [users, setUsers] = useState([]);
  const [remoteCursors, setRemoteCursors] = useState([]);
  const [typing, setTyping] = useState("");
  const [joinError, setJoinError] = useState("");
  const [isPreview, setIsPreview] = useState(false);
  const [paperHeight, setPaperHeight] = useState(0);
  const [saveStatus, setSaveStatus] = useState("Saved");
  const [shareStatus, setShareStatus] = useState("");
  const ydocRef = useRef(null);
  const textObserverRef = useRef(null);
  const titleObserverRef = useRef(null);
  const updateHandlerRef = useRef(null);
  const cursorOverlayRef = useRef(null);
  const documentCanvasRef = useRef(null);
  const documentMeasureRef = useRef(null);
  const documentPageRef = useRef(null);
  const saveSequenceRef = useRef(0);

  useEffect(() => {
    socket.on("userJoined", (users) => {
      setUsers(normalizeRoomUsers(users));
    });

    const applyDocumentUpdate = (update) => {
      const updateBytes = normalizeYjsUpdate(update);
      if (!ydocRef.current || !updateBytes) return;

      try {
        Y.applyUpdate(ydocRef.current, updateBytes, "socket");
        setDocumentReady(true);
      } catch {
        setJoinError("Received an invalid document update.");
      }
    };

    socket.on("documentState", applyDocumentUpdate);
    socket.on("documentUpdate", applyDocumentUpdate);

    const applyCursorUpdate = (cursor) => {
      if (!cursor?.socketId) return;
      setRemoteCursors((current) => [
        ...current.filter((entry) => entry.socketId !== cursor.socketId),
        cursor,
      ]);
    };
    const applyCursorState = (cursors) => {
      setRemoteCursors(Array.isArray(cursors) ? cursors : []);
    };
    const removeCursor = (socketId) => {
      setRemoteCursors((current) => current.filter((cursor) => cursor.socketId !== socketId));
    };

    socket.on("cursorState", applyCursorState);
    socket.on("cursorUpdate", applyCursorUpdate);
    socket.on("cursorLeft", removeCursor);

    socket.on("userTyping", (user) => {
      setTyping(`${user.slice(0, 8)}... is Typing`);
      setTimeout(() => setTyping(""), 2000);
    });

    return () => {
      socket.off("userJoined");
      socket.off("documentState", applyDocumentUpdate);
      socket.off("documentUpdate", applyDocumentUpdate);
      socket.off("cursorState", applyCursorState);
      socket.off("cursorUpdate", applyCursorUpdate);
      socket.off("cursorLeft", removeCursor);
      socket.off("userTyping");
    };
  }, []);

  useEffect(() => {
    const handleBeforeUnload = () => {
      socket.emit("leaveRoom");
    };

    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, []);

  const joinRoom = () => {
    if (roomId && userName) {
      setJoinError("");
      setDocumentReady(false);

      const sharedDoc = new Y.Doc();
      const source = sharedDoc.getText("source");
      const sharedTitle = sharedDoc.getText("title");
      const handleTextChange = () => setContent(source.toString());
      const handleTitleChange = () => setTitle(sharedTitle.toString());
      const handleDocumentUpdate = (update, origin) => {
        if (origin !== "socket") {
          const saveSequence = ++saveSequenceRef.current;
          setSaveStatus("Saving...");
          socket.emit("documentUpdate", { update }, (response) => {
            if (saveSequence === saveSequenceRef.current) {
              setSaveStatus(response?.ok ? "Saved" : "Save failed");
            }
          });
          socket.emit("typing");
        }
      };

      source.observe(handleTextChange);
      sharedTitle.observe(handleTitleChange);
      sharedDoc.on("update", handleDocumentUpdate);
      ydocRef.current = sharedDoc;
      textObserverRef.current = handleTextChange;
      titleObserverRef.current = handleTitleChange;
      updateHandlerRef.current = handleDocumentUpdate;

      socket.emit("join", { roomId, userName }, (response) => {
        if (response?.ok) {
          setJoined(true);
          setSaveStatus("Saved");
        } else {
          source.unobserve(handleTextChange);
          sharedTitle.unobserve(handleTitleChange);
          sharedDoc.off("update", handleDocumentUpdate);
          sharedDoc.destroy();
          ydocRef.current = null;
          setDocumentReady(false);
          textObserverRef.current = null;
          titleObserverRef.current = null;
          updateHandlerRef.current = null;
          setJoinError(response?.error || "Unable to join this room.");
        }
      });
    }
  };

  const disposeSharedDocument = () => {
    const sharedDoc = ydocRef.current;
    if (sharedDoc) {
      const source = sharedDoc.getText("source");
      const sharedTitle = sharedDoc.getText("title");
      if (textObserverRef.current) {
        source.unobserve(textObserverRef.current);
      }
      if (titleObserverRef.current) {
        sharedTitle.unobserve(titleObserverRef.current);
      }
      if (updateHandlerRef.current) {
        sharedDoc.off("update", updateHandlerRef.current);
      }
      sharedDoc.destroy();
    }

    ydocRef.current = null;
    textObserverRef.current = null;
    titleObserverRef.current = null;
    updateHandlerRef.current = null;
  };

  const leaveRoom = () => {
    socket.emit("leaveRoom");
    disposeSharedDocument();
    setJoined(false);
    setDocumentReady(false);
    setRoomId("");
    setUserName("");
    setRemoteCursors([]);
    setTitle("");
    setContent("");
    setIsPreview(false);
    setSaveStatus("Saved");
    setShareStatus("");
  };

  const handleContentChange = (event) => {
    if (ydocRef.current) {
      replaceSharedText(ydocRef.current, "source", event.target.value);
      emitCursorUpdate(event.target.selectionStart, event.target.selectionEnd);
    }
  };

  const emitCursorUpdate = (anchorIndex, headIndex) => {
    const sharedDoc = ydocRef.current;
    if (!sharedDoc || !documentReady) return;

    const source = sharedDoc.getText("source");
    const anchor = Y.createRelativePositionFromTypeIndex(
      source,
      Math.min(anchorIndex, source.length)
    );
    const head = Y.createRelativePositionFromTypeIndex(
      source,
      Math.min(headIndex, source.length)
    );
    socket.emit("cursorUpdate", {
      anchor: Y.encodeRelativePosition(anchor),
      head: Y.encodeRelativePosition(head),
    });
  };

  useEffect(() => {
    const measurePaper = () => {
      const page = documentPageRef.current;
      const measure = documentMeasureRef.current;
      if (!page || !measure || isPreview) return;

      const pageStyle = window.getComputedStyle(page);
      const pagePadding =
        Number.parseFloat(pageStyle.paddingTop) + Number.parseFloat(pageStyle.paddingBottom);
      const availableHeight = page.clientHeight - pagePadding - 42;
      setPaperHeight(Math.max(availableHeight, measure.scrollHeight));
    };

    measurePaper();
    window.addEventListener("resize", measurePaper);
    return () => window.removeEventListener("resize", measurePaper);
  }, [content, documentReady, isPreview]);

  const handleDownloadDocument = () => {
    const safeTitle = Array.from(title.trim() || roomId, (character) =>
      character.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(character)
        ? "-"
        : character
    ).join("").replace(/[. ]+$/g, "");
    const printWindow = window.open("", "_blank");
    if (!printWindow) return;

    printWindow.opener = null;
    const documentTitle = safeTitle || "document";
    const markdownHtml = renderToStaticMarkup(
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    );
    printWindow.addEventListener("load", () => {
      printWindow.focus();
      printWindow.print();
    }, { once: true });
    printWindow.document.write(`<!doctype html>
      <html><head><meta charset="utf-8"><title>${documentTitle}</title>
      <style>
        @page { margin: 20mm; }
        body { color: #202124; font: 12pt/1.6 Georgia, serif; margin: 0 auto; max-width: 760px; }
        h1, h2, h3, h4 { font-family: Arial, sans-serif; line-height: 1.25; margin-top: 1.5em; }
        h1 { border-bottom: 1px solid #d8dadd; padding-bottom: .3em; }
        a { color: #145a86; }
        blockquote { border-left: 3px solid #aeb6bd; color: #4d5963; margin-left: 0; padding-left: 1em; }
        code { background: #f1f3f4; font-family: monospace; padding: .1em .25em; }
        pre { background: #f1f3f4; overflow-wrap: anywhere; padding: 1em; white-space: pre-wrap; }
        table { border-collapse: collapse; width: 100%; }
        th, td { border: 1px solid #b8bec4; padding: .4em .6em; text-align: left; }
        img { max-width: 100%; }
      </style></head><body>${markdownHtml}</body></html>`);
    printWindow.document.close();
  };

  const handleEditorScroll = (event) => {
    if (cursorOverlayRef.current) {
      cursorOverlayRef.current.style.transform = `translateY(-${event.currentTarget.scrollTop}px)`;
    }
  };

  const handleTitleChange = (event) => {
    if (ydocRef.current) {
      replaceSharedText(ydocRef.current, "title", event.target.value);
    }
  };

  const copyInviteLink = async () => {
    const inviteUrl = new URL(window.location.href);
    inviteUrl.searchParams.set("room", roomId);

    try {
      await navigator.clipboard.writeText(inviteUrl.toString());
      setShareStatus("Link copied");
    } catch {
      setShareStatus("Copy unavailable");
    }
    window.setTimeout(() => setShareStatus(""), 2000);
  };

  if (!joined) {
    return (
      <div className="join-container">
        <header className="join-topbar">
          <a className="join-brand" href="/" aria-label="Real-Time Collaborative Editor home">
            <span>Real-Time Collaborative Editor</span>
          </a>
          <a className="join-contact" href="https://github.com/mohamedaradaib/Real-Time-Collaborative-Editor">
            Contact
          </a>
        </header>

        <main className="join-content">
          <section className="join-intro" aria-labelledby="join-title">
            <h1 id="join-title" className="join-title">
                An editor for
                <br />
                teams to document.
            </h1>
            <p className="join-description">
              Where you can write and edit documents with your team.
            </p>
          </section>

          <form
            className="join-form"
            onSubmit={(event) => {
              event.preventDefault();
              joinRoom();
            }}
          >
            <h2>Welcome</h2>
            <label className="visually-hidden" htmlFor="room-name">Room</label>
            <input
              id="room-name"
              type="text"
              placeholder="Room"
              value={roomId}
              onChange={(e) => setRoomId(e.target.value)}
              autoComplete="off"
            />
            <label className="visually-hidden" htmlFor="user-name">Name</label>
            <input
              id="user-name"
              type="text"
              placeholder="Name"
              value={userName}
              onChange={(e) => setUserName(e.target.value)}
              autoComplete="name"
            />
            {joinError && <p role="alert">{joinError}</p>}
            <button type="submit">Enter</button>
          </form>
        </main>

        <footer className="join-footer">
          <span>© 2026 Real-Time Collaborative Editor | About | Terms of Service | Privacy Policy | Security | Disclosure</span>
        </footer>
      </div>
    );
  }

  return (
    <div className="editor-container">
      <div className="sidebar">
        <div className="sidebar-header">
          <div className="room-info">
            <div>
              <input
                className="sidebar-title-input"
                value={title}
                onChange={handleTitleChange}
                aria-label="Document title"
                placeholder={roomId}
                maxLength={120}
                disabled={!documentReady}
              />
            </div>
          </div>
          <button className="share-button" onClick={copyInviteLink}>
            {shareStatus || "Copy link"}
          </button>
        </div>
        <div className="presence-heading">
          <h3>In this room</h3>
          <span>{users.length}</span>
        </div>
        <ul className="user-list">
          {users.map(({ socketId, userName: name }) => (
            <li key={socketId}>
              <span className="presence-name">{name}</span>
              {socketId === socket.id && <span className="you-label">you</span>}
            </li>
          ))}
        </ul>
        <p className="typing-indicator" aria-live="polite">{typing}</p>
        <div className="sidebar-bottom-actions">
          <button
            className="download-document-button"
            onClick={handleDownloadDocument}
            disabled={!documentReady}
          >
            Download
          </button>
          <button className="leave-button" onClick={leaveRoom}>Exit</button>
        </div>
      </div>

      <div className="editor-wrapper">
        <header className="document-toolbar">
          <div className="document-actions">
            <button
              className="preview-toggle-button"
              aria-pressed={isPreview}
              onClick={() => setIsPreview((current) => !current)}
            >
              {isPreview ? "Edit" : "Preview"}
            </button>
            <span className="save-status visually-hidden" aria-live="polite">{saveStatus}</span>
          </div>
        </header>
        <main className="document-page" ref={documentPageRef}>
          {isPreview ? (
            <article className="markdown-preview" aria-label="Markdown preview">
              {content ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
              ) : (
                <p className="preview-empty">Nothing to preview yet.</p>
              )}
            </article>
          ) : (
            <div
              className="document-editor"
              style={paperHeight ? { height: `${paperHeight}px` } : undefined}
            >
              {renderCursorOverlay({
                content,
                cursors: remoteCursors,
                sharedDoc: ydocRef.current,
                localSocketId: socket.id,
                contentRef: cursorOverlayRef,
              })}
              <textarea
                className="document-canvas"
                ref={documentCanvasRef}
                value={content}
                onChange={handleContentChange}
                onSelect={(event) => emitCursorUpdate(
                  event.currentTarget.selectionStart,
                  event.currentTarget.selectionEnd
                )}
                onKeyUp={(event) => emitCursorUpdate(
                  event.currentTarget.selectionStart,
                  event.currentTarget.selectionEnd
                )}
                onScroll={handleEditorScroll}
                placeholder="Start writing..."
                aria-label="Shared document content"
                spellCheck="true"
                disabled={!documentReady}
              />
              <div className="document-measure" ref={documentMeasureRef} aria-hidden="true">
                {content}
              </div>
            </div>
          )}
          <footer className="document-footer">
            <span>{content.trim() ? content.trim().split(/\s+/).length : 0} words</span>
            <span>{typing}</span>
          </footer>
        </main>
      </div>
      <footer className="app-footer">
        <span>© 2026 Real-Time Collaborative Editor | About | Terms of Service | Privacy Policy | Security | Disclosure</span>
      </footer>
    </div>
  );
};

export default App;