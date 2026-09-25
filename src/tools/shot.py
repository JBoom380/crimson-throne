"""Headless screenshot of the game.

python tools/shot.py out.png [--html dev.html] [--wait 3000] [--eval "AK.debug.go('LETTERS')"] [--eval2 "js" --wait2 1500]
Prints console errors and page errors. Uses a throwaway Chrome profile; never touches the user's browser.
"""
import argparse
import os
import sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ap = argparse.ArgumentParser()
ap.add_argument("out")
ap.add_argument("--html", default="dev.html")
ap.add_argument("--wait", type=int, default=3000)
ap.add_argument("--eval", default=None)
ap.add_argument("--eval2", default=None)
ap.add_argument("--wait2", type=int, default=1500)
ap.add_argument("--width", type=int, default=1280)
ap.add_argument("--height", type=int, default=720)
a = ap.parse_args()

path = a.html if os.path.isabs(a.html) else os.path.join(HERE, a.html)
url = "file:///" + os.path.abspath(path).replace("\\", "/")
errors = []
with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True,
                          args=["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"])
    pg = b.new_page(viewport={"width": a.width, "height": a.height})
    pg.set_default_timeout(90000)
    pg.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type in ("error", "warning") else None)
    pg.on("pageerror", lambda e: errors.append(f"PAGEERROR: {e}"))
    pg.goto(url)
    pg.wait_for_timeout(800)
    if a.eval:
        pg.evaluate(a.eval)
    pg.wait_for_timeout(a.wait)
    if a.eval2:
        pg.evaluate(a.eval2)
        pg.wait_for_timeout(a.wait2)
    fps = pg.evaluate("new Promise(r=>{let n=0;const s=performance.now();function f(){n++;if(performance.now()-s<1000)requestAnimationFrame(f);else r(n)}requestAnimationFrame(f)})")
    pg.screenshot(path=a.out)
    b.close()
print(f"saved {a.out}  (~{fps} fps, real GPU)")
for e in errors:
    print(e[:400])
if any(e.startswith("PAGEERROR") for e in errors):
    sys.exit(1)
