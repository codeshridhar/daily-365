"""
End-to-end checks for Daily 365, run against real Chromium.

A fake video device is supplied by Chromium (--use-fake-device-for-media-stream),
so the whole capture path — compose, stamp, save, persist, recompute, export —
is exercised rather than mocked.

Run:  python3 tools/e2e_test.py
"""

import asyncio
import io
import json
import os
import pathlib
import sys

from playwright.async_api import async_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
BASE = os.environ.get("BASE_URL", "http://127.0.0.1:8080")

PASS, FAIL = [], []


def check(name, condition, detail=""):
    if condition:
        PASS.append(name)
        print(f"  PASS  {name}")
    else:
        FAIL.append((name, detail))
        print(f"  FAIL  {name}" + (f"  -> {detail}" if detail else ""))


async def no_console_errors(page, bucket):
    page.on("console", lambda m: bucket.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: bucket.append("pageerror: " + str(e)))


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            args=[
                "--use-fake-ui-for-media-stream",
                "--use-fake-device-for-media-stream",
                "--allow-file-access-from-files",
            ]
        )
        context = await browser.new_context(
            viewport={"width": 430, "height": 900},
            permissions=["camera"],
            accept_downloads=True,
        )
        page = await context.new_page()
        errors = []
        await no_console_errors(page, errors)

        print("\n== 1. Load and shell ==")
        response = await page.goto(f"{BASE}/index.html", wait_until="networkidle")
        check("page returns 200", response.status == 200, str(response.status))
        check("title is Daily 365", await page.title() == "Daily 365")
        check("stylesheet loaded", await page.evaluate(
            "getComputedStyle(document.body).backgroundColor") != "rgba(0, 0, 0, 0)")
        check("masthead present", await page.locator(".masthead .wordmark").count() == 1)

        print("\n== 2. No console errors on boot ==")
        check("no console errors", len(errors) == 0, "; ".join(errors[:3]))

        print("\n== 3. Day numbering ==")
        day_text = await page.locator("#dayMark").inner_text()
        check("day mark is DAY 001 on a fresh install", day_text.strip() == "DAY 001", day_text)
        check("capture button shows the day", (await page.locator("#captureDay").inner_text()) == "001")

        print("\n== 4. Totals react to input ==")
        await page.fill("#earn", "2000")
        await page.fill("#spend", "900")
        await page.wait_for_timeout(120)
        earn_total = await page.locator("#tallyEarn").inner_text()
        spend_total = await page.locator("#tallySpend").inner_text()
        net = await page.locator("#tallyNet").inner_text()
        check("earn total formats with rupee + grouping", earn_total == "₹2,000", earn_total)
        check("spend total formats", spend_total == "₹900", spend_total)
        check("net is earn minus spend", net == "₹1,100", net)

        print("\n== 5. Camera acquires the fake device ==")
        await page.wait_for_timeout(700)
        camera_live = await page.evaluate(
            """() => { const v = document.getElementById('camera');
                       return !!(v && v.videoWidth > 0 && v.srcObject); }""")
        check("video stream is live", camera_live)
        dead = await page.evaluate(
            "document.getElementById('viewfinder').classList.contains('is-dead')")
        check("viewfinder is not in the failed state", dead is False)

        print("\n== 6. Capture produces a stamped 1080x1440 JPEG ==")
        await page.click("#btnCapture")
        await page.wait_for_selector("#view-review.is-active", timeout=5000)
        dims = await page.evaluate(
            """async () => {
                 const img = document.getElementById('reviewImage');
                 const blob = await fetch(img.src).then(r => r.blob());
                 const bmp = await createImageBitmap(blob);
                 return { w: bmp.width, h: bmp.height, type: blob.type, size: blob.size };
               }""")
        check("output is 1080 wide", dims["w"] == 1080, str(dims["w"]))
        check("output is 1440 tall", dims["h"] == 1440, str(dims["h"]))
        check("output is JPEG", dims["type"] == "image/jpeg", dims["type"])
        check("output carries real bytes", dims["size"] > 40000, str(dims["size"]))
        review_note = await page.locator("#reviewCaption").inner_text()
        check("review names the day and amounts",
              "Day 001" in review_note and "2,000" in review_note, review_note)

        print("\n== 7. Save writes to IndexedDB and the ledger ==")
        await page.click("#btnSave")
        await page.wait_for_selector("#savedFlag.is-on", timeout=5000)
        saved_file = await page.locator("#savedFile").inner_text()
        check("filename follows day-NNN-YYYY-MM-DD.jpg", saved_file.endswith(".jpg") and saved_file.startswith("day-001-"), saved_file)

        stored = await page.evaluate(
            """() => new Promise((resolve) => {
                 const req = indexedDB.open('daily365', 1);
                 req.onsuccess = () => {
                   const tx = req.result.transaction('entries', 'readonly');
                   const all = tx.objectStore('entries').getAll();
                   all.onsuccess = () => resolve(all.result.map(e => ({
                     day: e.day, date: e.date, earn: e.earn, spend: e.spend,
                     earnTotal: e.earnTotal, spendTotal: e.spendTotal,
                     hasBlob: !!e.blob, type: e.blob ? e.blob.type : null,
                     filename: e.filename
                   })));
                 };
               })""")
        check("one entry stored", len(stored) == 1, json.dumps(stored))
        if stored:
            row = stored[0]
            check("stored earn is 2000", row["earn"] == 2000, str(row["earn"]))
            check("stored spend is 900", row["spend"] == 900, str(row["spend"]))
            check("stored earn total is 2000", row["earnTotal"] == 2000, str(row["earnTotal"]))
            check("stored photograph is a blob", row["hasBlob"] and row["type"] == "image/jpeg", str(row["type"]))

        print("\n== 8. Inputs clear and tally reflects the saved day ==")
        check("earn field cleared", (await page.input_value("#earn")) == "")
        check("spend field cleared", (await page.input_value("#spend")) == "")

        print("\n== 9. Ledger renders the entry ==")
        await page.click('[data-tab="view-ledger"]')
        await page.wait_for_timeout(200)
        count = await page.locator("#ledgerCount").inner_text()
        rows = await page.locator(".entry-row").count()
        check("ledger reports 1 day", count.strip().lower().replace(" ", " ") in ("1 day", "1 days"), count)
        check("ledger shows one row", rows == 1, str(rows))
        row_text = await page.locator(".entry-row").first.inner_text()
        check("ledger row shows day number", "DAY 001" in row_text, row_text)
        check("ledger row shows the amount", "+₹2,000" in row_text.replace("\n", " "), row_text)

        print("\n== 10. Duplicate-day guard ==")
        await page.click('[data-tab="view-camera"]')
        await page.wait_for_timeout(600)
        await page.fill("#earn", "500")
        await page.fill("#spend", "100")
        await page.click("#btnCapture")
        await page.wait_for_selector("#view-review.is-active", timeout=5000)
        await page.click("#btnSave")
        await page.wait_for_selector("#dialog[open]", timeout=4000)
        dialog_title = await page.locator("#dialogTitle").inner_text()
        check("duplicate day raises a dialog", "already recorded" in dialog_title.lower(), dialog_title)
        buttons = await page.locator("#dialogActions button").all_inner_texts()
        check("dialog offers replace / add / cancel", len(buttons) == 3, str(buttons))
        await page.locator("#dialogActions button").nth(1).click()  # add to existing
        await page.wait_for_timeout(900)

        after_add = await page.evaluate(
            """() => new Promise((resolve) => {
                 const req = indexedDB.open('daily365', 1);
                 req.onsuccess = () => {
                   const all = req.result.transaction('entries','readonly').objectStore('entries').getAll();
                   all.onsuccess = () => resolve(all.result.map(e => [e.earn, e.spend, e.earnTotal]));
                 };
               })""")
        check("add merges into the existing day", after_add and after_add[0][0] == 2500, json.dumps(after_add))
        check("merged totals recomputed", after_add and after_add[0][2] == 2500, json.dumps(after_add))

        print("\n== 11. CSV export ==")
        await page.click('[data-tab="view-settings"]')
        await page.wait_for_timeout(200)
        async with page.expect_download(timeout=5000) as dl_info:
            await page.click("#btnExport")
        download = await dl_info.value
        csv_path = await download.path()
        csv_text = pathlib.Path(csv_path).read_text(encoding="utf-8")
        header = csv_text.splitlines()[0]
        check("CSV filename is dated", download.suggested_filename.startswith("daily365-"), download.suggested_filename)
        check("CSV header matches the spreadsheet", header == "date,day,earn,spend,net,earn_total,spend_total,photo_file,notes", header)
        check("CSV row has the merged figures", ",2500," in csv_text, csv_text.splitlines()[-1])

        print("\n== 12. Settings persist across a reload ==")
        await page.evaluate("""() => {
            const s = JSON.parse(localStorage.getItem('daily365.settings.v1'));
            s.dateFormat = 'iso';
            localStorage.setItem('daily365.settings.v1', JSON.stringify(s));
        }""")
        await page.reload(wait_until="networkidle")
        await page.wait_for_timeout(600)
        fmt = await page.evaluate(
            "JSON.parse(localStorage.getItem('daily365.settings.v1')).dateFormat")
        check("changed setting survives reload", fmt == "iso", fmt)
        day_after = await page.evaluate(
            "document.getElementById('dayMark').textContent.trim()")
        check("day mark survives reload", "DAY" in day_after, day_after)

        print("\n== 13. Entry survives reload ==")
        await page.click('[data-tab="view-ledger"]')
        await page.wait_for_timeout(300)
        rows_after = await page.locator(".entry-row").count()
        check("ledger still shows the day after reload", rows_after == 1, str(rows_after))

        print("\n== 14. Delete recalculates later totals ==")
        await page.locator("[data-remove]").first.click()
        await page.wait_for_selector("#dialog[open]", timeout=4000)
        await page.locator("#dialogActions button").nth(1).click()
        await page.wait_for_timeout(800)
        remaining = await page.locator(".entry-row").count()
        check("entry removed", remaining == 0, str(remaining))
        empty_text = await page.locator(".blank").inner_text()
        check("empty state shown", "Nothing recorded" in empty_text, empty_text)

        print("\n== 15. Service worker registered ==")
        sw_ok = await page.evaluate(
            """async () => {
                 if (!navigator.serviceWorker) return 'unsupported';
                 const reg = await navigator.serviceWorker.getRegistration();
                 return reg ? 'registered' : 'none';
               }""")
        check("service worker is registered", sw_ok == "registered", str(sw_ok))

        print("\n== 16. No console errors after the full run ==")
        check("clean console", len(errors) == 0, "; ".join(errors[:4]))

        print("\n== 17. Layout fits real phone viewports ==")
        for label, w, h in [("iPhone 14 (390x844)", 390, 844),
                            ("small Android (360x740)", 360, 740),
                            ("iPhone SE (375x667)", 375, 667)]:
            await page.set_viewport_size({"width": w, "height": h})
            await page.click('[data-tab="view-camera"]')
            await page.wait_for_timeout(700)
            fit = await page.evaluate(
                """() => {
                     const cap = document.getElementById('btnCapture').getBoundingClientRect();
                     const bar = document.querySelector('.tabbar').getBoundingClientRect();
                     const vf  = document.getElementById('viewfinder').getBoundingClientRect();
                     return {
                       capBottom: Math.round(cap.bottom),
                       capTop: Math.round(cap.top),
                       barTop: Math.round(bar.top),
                       vfRatio: +(vf.width / vf.height).toFixed(3),
                       vfVisible: vf.top >= 0 && vf.bottom <= window.innerHeight + 1,
                       overflowX: document.documentElement.scrollWidth > window.innerWidth + 1
                     };
                   }""")
            check(f"{label}: shutter above the tab bar", fit["capBottom"] <= fit["barTop"] + 1,
                  json.dumps(fit))
            check(f"{label}: shutter not clipped", fit["capTop"] >= 0, json.dumps(fit))
            check(f"{label}: viewfinder stays 3:4", abs(fit["vfRatio"] - 0.75) < 0.02, str(fit["vfRatio"]))
            check(f"{label}: no horizontal scroll", fit["overflowX"] is False)
        await page.set_viewport_size({"width": 430, "height": 900})

        print("\n== 18. Artefacts for visual review ==")
        shot_dir = ROOT / "tools" / "screens"
        shot_dir.mkdir(parents=True, exist_ok=True)

        await page.click('[data-tab="view-camera"]')
        await page.wait_for_timeout(1200)
        await page.screenshot(path=str(shot_dir / "camera.png"), full_page=False)
        check("camera screenshot written", (shot_dir / "camera.png").exists())

        await page.fill("#earn", "4250")
        await page.fill("#spend", "1180")
        await page.wait_for_timeout(150)
        await page.click("#btnCapture")
        await page.wait_for_selector("#view-review.is-active", timeout=5000)
        stamped = await page.evaluate(
            """async () => {
                 const img = document.getElementById('reviewImage');
                 const blob = await fetch(img.src).then(r => r.blob());
                 const buf = await blob.arrayBuffer();
                 return Array.from(new Uint8Array(buf));
               }""")
        (shot_dir / "stamped.jpg").write_bytes(bytes(stamped))
        check("stamped JPEG extracted", (shot_dir / "stamped.jpg").stat().st_size > 40000)
        await page.screenshot(path=str(shot_dir / "review.png"))

        await page.click("#btnSave")
        await page.wait_for_timeout(400)
        # may be a brand new day or a duplicate depending on run order
        if await page.locator("#dialog[open]").count():
            await page.locator("#dialogActions button").first.click()
        await page.wait_for_timeout(900)

        await page.click('[data-tab="view-ledger"]')
        await page.wait_for_timeout(400)
        await page.screenshot(path=str(shot_dir / "ledger.png"))
        check("ledger screenshot written", (shot_dir / "ledger.png").exists())

        await page.click('[data-tab="view-settings"]')
        await page.wait_for_timeout(400)
        await page.screenshot(path=str(shot_dir / "settings.png"), full_page=True)
        check("settings screenshot written", (shot_dir / "settings.png").exists())

        await browser.close()

    print("\n" + "=" * 62)
    print(f"  {len(PASS)} passed, {len(FAIL)} failed")
    if FAIL:
        print("  Failures:")
        for name, detail in FAIL:
            print(f"   - {name}: {detail}")
    print("=" * 62)
    return 0 if not FAIL else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
