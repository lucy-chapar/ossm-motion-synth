#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Export a self-contained HTTPS website with direct Web Serial support."""

import argparse
import hashlib
import json
from pathlib import Path
import shutil


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ("style.css", "app.js", "audio.js", "tooltips.js", "ruckig-core.js",
          "ruckig-core.wasm", "ruckig-LICENSE.txt", "browser-engine.js", "browser-runtime.js",
          "web-serial-io.js", "web-serial-transport.js", "worker.js", "worker-client.js")


def export(destination):
    source = ROOT / "virtual_synth" / "static"
    destination = Path(destination).resolve()
    if destination == ROOT or ROOT.is_relative_to(destination) or destination == source:
        raise ValueError("Choose a separate output directory")
    missing = [name for name in ASSETS if not (source / name).is_file()]
    if missing:
        raise ValueError(f"Missing browser assets: {', '.join(missing)}")
    destination.mkdir(parents=True, exist_ok=True)
    for name in ASSETS:
        shutil.copyfile(source / name, destination / name)
    # Worker imports and the window client form a dependency graph. Version
    # each dependency from the bytes actually exported, not the source loader.
    worker_file = destination / "worker.js"
    worker_source = worker_file.read_text()
    for name in ("ruckig-core.js", "browser-engine.js", "web-serial-io.js", "web-serial-transport.js", "browser-runtime.js"):
        version = hashlib.sha256((destination / name).read_bytes()).hexdigest()[:12]
        worker_source = worker_source.replace(f'"./{name}"', f'"./{name}?v={version}"')
    worker_file.write_text(worker_source)
    version = hashlib.sha256(worker_file.read_bytes()).hexdigest()[:12]
    client_file = destination / "worker-client.js"
    client_file.write_text(client_file.read_text().replace('"./worker.js"', f'"./worker.js?v={version}"'))
    html = (source / "index.html").read_text()
    html = html.replace('href="/style.css"', 'href="./style.css"')
    for name in ("audio.js", "tooltips.js", "app.js"):
        html = html.replace(f'src="/{name}"', f'src="./{name}"')
    html = html.replace('href="/" aria-label="OSSM', 'href="./" aria-label="OSSM')
    runtime = '  <script src="./worker-client.js" defer></script>'
    html = html.replace('  <script src="./app.js" defer></script>', runtime + '\n  <script src="./app.js" defer></script>')
    html = html.replace("Connecting to local app", "Starting browser synth")
    # A new export must not reuse a visitor's cached scripts or styles.
    for name in ASSETS:
        version = hashlib.sha256((destination / name).read_bytes()).hexdigest()[:12]
        html = html.replace(f'"./{name}"', f'"./{name}?v={version}"')
    (destination / "index.html").write_text(html)
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
