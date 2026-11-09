# Daily 365

One photograph a day, stamped with the date, the day number, what you earned and
what you spent, plus running totals. Photographs are stored on the device in
IndexedDB; saving to Google Drive is a share-sheet hand-off you control.

No build step. No framework. No dependencies. Three files and a stylesheet.

---

## What it does

Each day you open the app, type two numbers, and take a photograph. The numbers
are burned into the JPEG in the bottom-right of the frame:

```
DATE          07 Nov 2026
DAY                 042
EARN              4,250
SPEND             1,180
─────────────────────────
EARN TOTAL        48,500
SPEND TOTAL       21,300
```

Day number and both totals are calculated. You type only Earn and Spend.

Because the stamp is written into the pixels, it cannot come adrift from the
photograph years later. The trade-off is that it cannot be edited afterwards,
so every irreversible step asks for confirmation first.

---

## Running it

The camera API requires a **secure context**. `localhost` counts, and so does
`http://127.0.0.1`. Opening the HTML file directly with `file://` does not.

### Option A — VS Code, one click

1. Open this folder in VS Code.
2. Install the **Live Server** extension (Ritwick Dey).
3. Right-click `index.html` → **Open with Live Server**.

It serves on `http://127.0.0.1:5500` and the camera will work.

### Option B — Python, no extensions

```bash
cd daily-365
python3 -m http.server 8080
```

Then open <http://127.0.0.1:8080>.

### Option C — test on your phone

Localhost on your laptop is not reachable from your phone. Use a tunnel:

```bash
npx localtunnel --port 8080      # or: cloudflared tunnel --url http://localhost:8080
```

Open the https URL it prints on your phone, then add it to the home screen
(Share → Add to Home Screen) so it runs fullscreen without browser chrome.

---

## Using it

| Step | What happens |
| --- | --- |
| Type Earn / Spent | Totals update live before you shoot, so you see the number you are about to commit to |
| Capture | The frame is cropped to 3:4 and stamped at 1080 × 1440 |
| Review | Retake, Save, or Save and download a copy |
| Save | Written to IndexedDB, totals recomputed, entry appears in the Ledger |
| Save to Drive | Saves here, then opens the share sheet so you pick Drive and the folder |

The app will stop and ask you about: a day that already exists (replace / add /
cancel), a gap in the sequence, both amounts being zero, and an earn figure more
than six times your average.

### Getting the alignment right

The framing guides and the ghost overlay are aids, but the real work is done by
your setup:

- Put the phone in the same place every day — a tripod, or tape marks on the floor.
- Lock the zoom. Never pinch between days.
- Enable guides and ghost, and line your eyes up with yesterday's silhouette.

When you come to assemble the video, re-crop each frame so the eyes land on the
same coordinates. That fixes the days you drifted.

---

## Saving to Google Drive

There is **no Google login, client ID, or Drive permission** in this app. Instead:

1. Capture and review the photograph.
2. Tap **Save to Drive**.
3. The photo is stored on the device first, then your phone's **share sheet** opens.
4. Choose **Google Drive** (or any other app) and pick the folder yourself.

The filename is generated automatically — `day-042-2026-11-07.jpg` — so it sorts
cleanly in Drive. Because the app never receives a token, it cannot read anything
in your Drive: the OS does the hand-off, not the app.

On browsers without file sharing, the same button opens the system save dialog,
and falls back to a normal download.

Notes worth knowing:

- Nothing is uploaded automatically. You choose every share.
- Data still lives on this device in IndexedDB; the share is a copy, not a sync.
- Two phones each keep their own ledger. Move numbers between them with the CSV.

---

## The spreadsheet

`Daily 365 Tracker.xlsx` carries the same columns as the CSV export. Set the
**Day one** date on the Dashboard so its dates line up with the app's, then
either paste the export in or type Earn and Spend by hand and let the Totals
columns calculate.

Export a CSV at the end of every month. It is the only copy of your numbers that
survives a cleared browser.

---

## Files

```
daily-365/
├── index.html                  markup only
├── assets/
│   ├── styles.css              design tokens and layout
│   └── app.js                  all behaviour, ~1100 lines, no dependencies
├── icons/                      app icons (192, 512, maskable)
├── manifest.webmanifest        installable PWA
├── sw.js                       offline shell
├── Daily 365 Tracker.xlsx      companion spreadsheet
└── tools/
    ├── e2e_test.py             59 end-to-end checks in real Chromium
    ├── camera-check.html       camera diagnostic page
    └── screens/                screenshots written by the test run
```

---

## Testing

```bash
pip install playwright
python3 -m playwright install chromium

cd daily-365
python3 -m http.server 8080 &
python3 tools/e2e_test.py
python3 tools/drive_flow_test.py
```

Chromium is launched with a fake video device, so the real capture path runs:
compose, stamp, encode, persist, recompute, export. The suite also checks layout
at three phone viewport sizes. Last run: **60 passed, 0 failed**.

It writes `tools/screens/` — camera, review, ledger, settings, and a real stamped
JPEG you can inspect.

---

## How it works, briefly

**Storage.** IndexedDB, one record per day, keyed by day number. Each record holds
both numbers and the JPEG blob.

**Totals.** Never trusted from storage. After any mutation the ledger is walked in
day order and every total is recomputed, so replacing day 3 correctly fixes days
4 onwards. Storing a total once and leaving it would go stale the moment an old
day changed.

**Day numbers.** Derived from a fixed start date, not a counter. Skipping a day
leaves a visible gap rather than silently renumbering the year.

**Mirroring.** Only applied to a live selfie stream. A file chosen from the
gallery is used exactly as it is.

**Camera selection.** Three attempts in order: your chosen device, then the
requested facing, then any video device. Virtual cameras — Camo, OBS, EpocCam —
usually report no facing direction, which is why the last attempt exists.

---

## Known limits

- Photographs live in this browser's storage. Clearing site data deletes them.
  Export the CSV, and keep the JPEGs if you care about them.
- There is no sync between devices. Move data with the CSV.
- Saving to Drive is a share-sheet hand-off, not a background sync.
- The video is not built yet. `ffmpeg` with a face-landmark re-crop pass is the
  intended approach.
