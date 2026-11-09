"""
Focused check for the Save to Drive hand-off.

Web Share is stubbed so the test can see exactly what the page would hand to
the operating system: one JPEG file, named by the app, with real bytes. It also
confirms the entry is persisted before the share sheet opens.

Run:  python3 tools/drive_flow_test.py
"""

import asyncio
import json
import pathlib

from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:8080"

INIT = """
(() => {
  window.__shares = [];
  Object.defineProperty(navigator, 'canShare', {
    configurable: true,
    value: (data) => !!(data && data.files && data.files.length)
  });
  Object.defineProperty(navigator, 'share', {
    configurable: true,
    value: async (data) => {
      window.__shares.push({
        title: data && data.title,
        count: data && data.files ? data.files.length : 0,
        names: data && data.files ? Array.from(data.files).map(f => f.name) : [],
        types: data && data.files ? Array.from(data.files).map(f => f.type) : [],
        sizes: data && data.files ? Array.from(data.files).map(f => f.size) : []
      });
    }
  });
})();
"""


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(args=[
            "--use-fake-ui-for-media-stream",
            "--use-fake-device-for-media-stream",
        ])
        ctx = await browser.new_context(
            viewport={"width": 390, "height": 844}, permissions=["camera"]
        )
        await ctx.add_init_script(INIT)
        page = await ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        await page.goto(f"{BASE}/index.html", wait_until="networkidle")
        await page.fill("#earn", "2500")
        await page.fill("#spend", "700")
        await page.click("#btnCapture")
        await page.wait_for_selector("#view-review.is-active")
        await page.wait_for_timeout(300)

        # First press: save locally, then share.
        await page.click("#btnSaveDrive")
        await page.wait_for_timeout(800)

        shares = await page.evaluate("window.__shares")
        stored = await page.evaluate("""() => new Promise((res) => {
            const r = indexedDB.open('daily365', 1);
            r.onsuccess = () => {
              const g = r.result.transaction('entries','readonly').objectStore('entries').getAll();
              g.onsuccess = () => res(g.result.map(e => ({day:e.day, filename:e.filename, hasBlob:!!e.blob})));
            };
          })""")
        saved_flag = await page.locator("#savedFlag").get_attribute("class")

        print("shares:", json.dumps(shares, indent=2))
        print("stored:", json.dumps(stored))
        print("pageerrors:", errors)

        checks = {
            "share sheet opened once": len(shares) == 1,
            "exactly one file shared": bool(shares) and shares[0]["count"] == 1,
            "filename is auto-generated": bool(shares)
                and shares[0]["names"][0].startswith("day-001-")
                and shares[0]["names"][0].endswith(".jpg"),
            "file is JPEG": bool(shares) and shares[0]["types"][0] == "image/jpeg",
            "file has real bytes": bool(shares) and shares[0]["sizes"][0] > 40000,
            "entry persisted": len(stored) == 1 and stored[0]["hasBlob"],
            "saved flag visible": "is-on" in (saved_flag or ""),
            "no page errors": not errors,
        }
        for name, ok in checks.items():
            print(("  PASS  " if ok else "  FAIL  ") + name)

        await page.screenshot(path=str(pathlib.Path("tools/screens/drive-flow.png")))
        await browser.close()

        failed = [name for name, ok in checks.items() if not ok]
        print("\n" + ("ALL PASSED" if not failed else "FAILED: " + ", ".join(failed)))
        raise SystemExit(0 if not failed else 1)


asyncio.run(main())
