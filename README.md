# JavaCur — Java for the Curious (local edition)

Runs entirely on your machine. No Claude account, no internet required (fonts fall back to system fonts when offline), **no npm install**.

## Run it
```bash
node server.js          # then open http://localhost:3000
```
Needs Node 18+ (`node --version`). Use `PORT=4000 node server.js` for another port.

## Demo accounts (password for all: `Password1`)
| Email | Role |
|---|---|
| owner@javacur.local | 👑 Owner |
| super@javacur.local | ⭐ Super Admin |
| admin@javacur.local | 🛡️ Admin (forum, ratings, unlock — not delete users) |
| student@javacur.local | Student |
| lena@javacur.local | Student |

Two-factor codes are shown on screen (simulated — no real email/SMS is sent).

## Start clean
- Delete `data/db.json` and restart → demo data is re-created.
- `node server.js --no-seed` (with no `data/db.json`) → empty database; **the first person to sign up becomes the Owner.**

## Project layout
```
server.js              static file server + tiny JSON database API (/api/...)
public/index.html      page shell
public/css/styles.css  all styling
public/js/app.js       the whole app (UI, routing, lessons, quizzes, admin)
public/js/shim.js      browser-side database/identity layer talking to server.js
public/data/courses.json  the 44 lessons across 4 courses
public/data/codeq.json    the per-course code-writing exam questions
data/db.json           created on first run — users, forum, ratings, custom content
```

## Open in your editor
- **VS Code:** File → Open Folder → this folder. Run `node server.js` in the terminal.
- **IntelliJ:** File → Open → this folder. Add a *Node.js* run configuration with `server.js` as the JavaScript file (needs the Node.js plugin, bundled in Ultimate; or just use the Terminal tab).

## Good to know (it's a demo build)
- Passwords are stored as unsalted SHA-256 hashes and the API has no server-side permission checks — fine for a local showcase, **not for the public internet**. Roles are enforced by the UI only.
- Data is shared by everyone who can reach the server (open `http://<your-ip>:3000` from another device on the same network; the server listens on all interfaces).
- Live updates (forum, roster, ratings) use 1.5-second polling.
