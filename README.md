# Real-Time Collaborative Platform

Real time browser-based collaborative platform where multiple users can join a room and text, edit, and review documents together in real time.

## Features
- Real-time collaborative workspace with concurrent changes merged automatically
- Room-based sessions with active user presence, typing indicators, live cursors, and selection highlights
- Markdown writing and rendered preview with GitHub-flavored syntax
- Shared document titles, automatic persistence, PDF export, word count, and copyable room links
- Persistent document titles and content for each room

## Tech Stack
- JavaScript
- HTML
- CSS
- React
- Vite
- Node.js
- Express.js
- SQLite
- Socket.IO
- Yjs
- React Markdown

## How It Works
The Markdown writing canvas and title are bound to a shared Yjs document. Yjs merges concurrent edits, and Socket.IO synchronizes document updates and room presence between users. Relative cursor positions and selections are broadcast to room members and removed when a user leaves; cursor presence is temporary and is not stored. The backend stores each room's title and content in SQLite and automatically saves edits, acknowledging writes so the editor can show save status. The sidebar can export the current document as a PDF through the browser's print dialog. Existing rooms are migrated from their saved source code without losing text. Copying a room link includes the room name, which is prefilled for invitees. Rooms do not require sign-in, so anyone who knows a room name can join; do not use private or sensitive content, and only deploy this application where you trust the users who can access it.

## Getting Started
### Prerequisites
- Node.js 18+

### Installation

1. Clone the repository and install backend dependencies from the project root:
```bash
git clone https://github.com/mohamedaradaib/Collaborative-Editor
cd Collaborative-Editor
npm install
```

2. Install frontend dependencies:
```bash
npm --prefix frontend install
```

### Run the Application

Open two terminals from the project root.

#### Terminal 1: Start the backend
```bash
npm start
```

#### Terminal 2: Start the frontend
```bash
npm --prefix frontend run dev -- --host 0.0.0.0
```

Then open the vite localhost url `http://localhost:5173`

## Live Demo
[https://real-time-collaborative-platfrom-production.up.railway.app/](https://real-time-collaborative-platfrom-production.up.railway.app/)

## Screenshots
![alt text](image.png)

![alt text](image-1.png)

## License
[LICENSE](./LICENSE)
