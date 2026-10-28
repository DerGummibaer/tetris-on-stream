# Chat Plays Tetris

A Tetris battle for your stream. Viewers open a website, type their name, and play on their own big field.
Your OBS overlay shows everyone's field live, sized to fit the screen together. Most points wins.

No server needed. The site is static (GitHub Pages), and the overlay itself acts as the match host:
players connect straight to it over WebRTC through the free PeerJS network.

## 1. Put it on GitHub Pages
1. Create a new **public** repository on GitHub, e.g. `chat-plays-tetris`.
2. Upload everything in this folder (keep the `js/` and `css/` folders).
3. Repo → **Settings → Pages** → Source: *Deploy from a branch* → Branch `main`, folder `/ (root)` → Save.
4. After a minute your site is at `https://YOURNAME.github.io/chat-plays-tetris/`.

## 2. Add the overlay to OBS
Add a **Browser** source:

| Setting | Value |
|---|---|
| URL | `https://YOURNAME.github.io/chat-plays-tetris/overlay.html?room=yourchannel` |
| Width / Height | `1920` × `1080` (or your canvas size) |
| Shutdown source when not visible | **off** (otherwise the match host stops) |
| Refresh browser when scene becomes active | **off** |

The background is transparent. Pick your own room name (letters, numbers, `-`, `_`).

**Only open the overlay once.** It is the host. If it's also open in a normal browser tab, the second copy
shows "room code in use" until you close one.

## 3. Tell chat
Post the link with the room already filled in:
`https://YOURNAME.github.io/chat-plays-tetris/?room=yourchannel`

The overlay bar also shows the site address and room code for people who type it in.

## How a round works
1. **Lobby** opens as soon as the first player joins. Everyone gets an empty field on the overlay with a READY / NOT READY stamp.
2. After **60 seconds**, the match starts as soon as **more than 55%** of players have pressed Ready (button or `R`).
3. 3-2-1 countdown. Everyone gets the **same piece sequence**, so it's fair.
4. The match runs **3 minutes**, or until everyone has topped out. Topped-out players keep their score.
5. **Results** show for 15 seconds, then a new lobby opens. People who joined mid-match play next round.

## Controls (players)
| Key | Action |
|---|---|
| `A` `D` / `←` `→` | Move |
| `W` / `↑` | Rotate clockwise |
| `Z` / `Q` | Rotate counter-clockwise (extra, as in official Tetris) |
| `S` / `↓` | Soft drop |
| `Space` | Hard drop |
| `C` / `Enter` | Hold |

## Rules (Tetris Guideline)
SRS rotation with wall kicks, 7-bag randomizer, hold once per piece, ghost piece, 5-piece preview,
0.5 s lock delay with up to 15 move resets, guideline gravity, a new level every 10 lines.

Scoring (× level): Single 100 · Double 300 · Triple 500 · Tetris 800 · T-Spin Mini 100/200 ·
T-Spin 400 · T-Spin Single 800 · Double 1200 · Triple 1600 · Back-to-Back ×1.5 · Combo 50 × combo ·
Perfect Clear 800/1200/1800/2000 (3200 for B2B Tetris) · Soft drop 1 per cell · Hard drop 2 per cell.

## Overlay options
Add to the overlay URL, e.g. `overlay.html?room=yourchannel&time=120&lobby=45`

| Option | Default | Meaning |
|---|---|---|
| `room` | random | Room code players enter |
| `time` | `180` | Match length in seconds |
| `lobby` | `60` | Seconds before the ready check can start the match |
| `ready` | `55` | Start when **more than** this % are ready |
| `results` | `15` | Seconds the results screen stays |
| `max` | `100` | Max players per room |
| `join` | site address | Text shown as "PLAY AT" (e.g. a short link) |

**Streamer hotkeys** (OBS: right-click the source → *Interact*): `F` force start now · `E` end match · `R` back to lobby.

## Test it alone first
Open both pages with `&local` in the same browser (several player tabs work):
`overlay.html?room=test&local&lobby=5` and `index.html?room=test&local`.
This uses the browser's tab-to-tab channel instead of the internet.

## Good to know
- Scores are calculated in each player's browser. That's fine for a fun stream game,
  but a determined cheater could fake a score.
- Connections go through the free public PeerJS service (which includes relay servers for strict networks).
  If it's ever down, players see "Connection problem, retrying".
- Players need a keyboard; there are no touch controls.
