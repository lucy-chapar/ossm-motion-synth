#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Export a self-contained HTTPS website with direct Web Serial support."""

import argparse
import hashlib
import json
from pathlib import Path
import shutil


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ("style.css", "app.js", "audio.js", "tooltips.js", "browser-engine.js",
          "browser-runtime.js", "web-serial-io.js", "web-serial-transport.js")


def export(destination):
    source = ROOT / "virtual_synth" / "static"
    destination = Path(destination).resolve()
    if destination == ROOT or ROOT.is_relative_to(destination) or destination == source:
        raise ValueError("Choose a separate output directory")
    missing = [name for name in ASSETS if not (source / name).is_file()]
    if missing:
        raise ValueError(f"Missing browser assets: {', '.join(missing)}")
    destination.mkdir(parents=True, exist_ok=True)
    html = (source / "index.html").read_text()
    html = html.replace('href="/style.css"', 'href="./style.css"')
    for name in ("audio.js", "tooltips.js", "app.js"):
        html = html.replace(f'src="/{name}"', f'src="./{name}"')
    html = html.replace('href="/" aria-label="OSSM', 'href="./" aria-label="OSSM')
    runtime = "\n".join(f'  <script src="./{name}" defer></script>' for name in (
        "browser-engine.js", "web-serial-io.js", "web-serial-transport.js", "browser-runtime.js"))
    html = html.replace('  <script src="./app.js" defer></script>', runtime + '\n  <script src="./app.js" defer></script>')
    html = html.replace("Connecting to local app", "Starting browser synth")
    (destination / "index.html").write_text(html)
    for name in ASSETS:
        shutil.copyfile(source / name, destination / name)
    for name in ("LICENSE", "NOTICE.md"):
        shutil.copyfile(ROOT / name, destination / name)
    manifest = {"repository": "https://github.com/lucy-chapar/ossm-motion-synth",
                "files": {name: hashlib.sha256((destination / name).read_bytes()).hexdigest()
                          for name in ("index.html", *ASSETS, "LICENSE", "NOTICE.md")}}
    (destination / "source-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return destination


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "dist" / "web")
    print(export(parser.parse_args().output))
