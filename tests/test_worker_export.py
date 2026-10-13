# SPDX-License-Identifier: MPL-2.0
"""Standalone worker export checks; temporary files and loopback assets only."""
import hashlib
import json
from pathlib import Path
import re
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from export_web import export
from serve_web import BrowserAssets
from virtual_synth.server import ASSETS


class WorkerExportTests(unittest.TestCase):
    def test_worker_dependency_versions_and_manifest_describe_actual_export(self):
        with tempfile.TemporaryDirectory() as temporary:
            destination = export(temporary)
            html = (destination / "index.html").read_text()
            self.assertIn("worker-client.js?v=", html)
            self.assertNotIn('src="./browser-runtime.js', html)
            self.assertNotIn('src="./ruckig-core.js', html)
            for filename in ("worker.js", "worker-client.js", "index.html"):
                content = (destination / filename).read_text()
                for dependency, version in re.findall(r'\./([\w-]+\.(?:js|wasm))\?v=([0-9a-f]+)', content):
                    digest = hashlib.sha256((destination / dependency).read_bytes()).hexdigest()
                    self.assertEqual(version, digest[:12], (filename, dependency))
            manifest = json.loads((destination / "source-manifest.json").read_text())
            for filename, digest in manifest["files"].items():
                self.assertEqual(hashlib.sha256((destination / filename).read_bytes()).hexdigest(), digest)
            loader = (destination / "worker.js").read_text()
            for dependency in ("browser-engine.js", "browser-runtime.js", "web-serial-io.js", "web-serial-transport.js", "ruckig-core.js"):
                self.assertIn(dependency + "?v=", loader)

    def test_worker_and_wasm_asset_mime_types(self):
        self.assertEqual(ASSETS["/ruckig-core.wasm"][1], "application/wasm")
        for name in ("worker.js", "worker-client.js"):
            self.assertEqual(ASSETS["/" + name][1], "text/javascript; charset=utf-8")
        # The standalone static server shares the standard MIME map.
        self.assertEqual(BrowserAssets.guess_type(object.__new__(BrowserAssets), "ruckig-core.wasm"), "application/wasm")


if __name__ == "__main__":
    unittest.main()
