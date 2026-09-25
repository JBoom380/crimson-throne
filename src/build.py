"""Inline every script from dev.html into ../fantasy.html (one offline file)."""
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "index.html")

html = open(os.path.join(HERE, "dev.html"), encoding="utf-8").read()
block = re.search(r"<!--SCRIPTS-->(.*?)<!--/SCRIPTS-->", html, re.S)
parts = []
for src in re.findall(r'<script src="([^"]+)"></script>', block.group(1)):
    path = os.path.join(HERE, src)
    if not os.path.exists(path):
        print("missing (skipped):", src)
        continue
    code = open(path, encoding="utf-8").read().replace("</script", "<\\/script")
    parts.append(f"<script>/* {src} */\n{code}\n</script>")
out = html[:block.start()] + "\n".join(parts) + html[block.end():]
open(OUT, "w", encoding="utf-8").write(out)
print(f"wrote {os.path.normpath(OUT)} ({len(out.encode('utf-8')) / 1e6:.2f} MB, {len(parts)} scripts)")
