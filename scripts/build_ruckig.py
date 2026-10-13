#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Rebuild the pinned offline Ruckig WASM core with portable WASI SDK 34."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / "vendor" / "ruckig"
PROVENANCE = VENDOR / "provenance.json"
SDK_RELEASE = "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-34/"
SDK_ARCHIVES = {
    ("Darwin", "arm64"): ("arm64-macos", "9c59398106b417f8f14913380fdf0097a8cc0ff4af9eb3ce0065a859e88d49e9"),
    ("Darwin", "x86_64"): ("x86_64-macos", "87d27fa8adc68dee59bfbf2e22a6d34ef717c34d6bf1d8af2a56fc929d9ce0eb"),
    ("Linux", "x86_64"): ("x86_64-linux", "b761e3a0721dbae9c09a0059e5fdb2bf917d1b4a8a7b430fb3b5aafb0984b2c4"),
    ("Linux", "aarch64"): ("arm64-linux", "f7e243dff54d60bcc576e94d6166b69f410f2500ae4a9ceef34315be10e77971"),
}
EXPORTS = ("ruckig_create_planner", "ruckig_destroy_planner", "ruckig_create_plan",
           "ruckig_destroy_plan", "ruckig_copy_plan", "ruckig_calculate",
           "ruckig_plan_metadata", "ruckig_sample", "ruckig_reset", "ruckig_update", "ruckig_state")
FLAGS = ("--target=wasm32-wasip1", "-mexec-model=reactor", "-std=c++17", "-O3",
         "-fno-exceptions", "-fno-rtti", "-ffunction-sections", "-fdata-sections",
         "-Ivendor/ruckig/upstream/include")
LINK_FLAGS = ("-Wl,--gc-sections", "-Wl,--strip-all", "-Wl,-z,stack-size=262144",
              "-Wl,--initial-memory=524288", "-Wl,--max-memory=16777216")


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def download_sdk(cache):
    key = (platform.system(), platform.machine())
    if key not in SDK_ARCHIVES:
        raise ValueError("Pass --sdk PATH to a portable WASI SDK 34 for this platform")
    suffix, expected = SDK_ARCHIVES[key]
    name = f"wasi-sdk-34.0-{suffix}"
    cache.mkdir(parents=True, exist_ok=True)
    archive = cache / f"{name}.tar.gz"
    if not archive.exists():
        print(f"Downloading official portable {name} into {cache}", flush=True)
        with urllib.request.urlopen(SDK_RELEASE + archive.name) as response, archive.open("wb") as output:
            while chunk := response.read(1024 * 1024):
                output.write(chunk)
    if sha256(archive) != expected:
        raise ValueError(f"SDK archive SHA-256 mismatch: {archive}")
    destination = cache / name
    if not (destination / "bin" / "clang++").is_file():
        with tarfile.open(archive) as source:
            source.extractall(cache, filter="data")
    return destination


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sdk", type=Path, default=os.environ.get("WASI_SDK_PATH"))
    parser.add_argument("--download-toolchain", action="store_true",
                        help="Download a SHA-verified portable SDK into the temporary cache")
    parser.add_argument("--cache", type=Path, default=Path(tempfile.gettempdir()) / "ossm-ruckig-wasi-sdk34")
    parser.add_argument("--update-provenance", action="store_true",
                        help="Record an intentional binding/binary change (upstream hashes stay pinned)")
    args = parser.parse_args()
    provenance = json.loads(PROVENANCE.read_text())
    upstream = {str(path.relative_to(VENDOR)): sha256(path)
                for path in (VENDOR / "upstream").rglob("*") if path.is_file()}
    if upstream != provenance["upstream_files"]:
        parser.error("Vendored upstream differs from pinned Ruckig 0.15.3 hashes")
    binding_hash = sha256(VENDOR / "bindings.cpp")
    if not args.update_provenance and binding_hash != provenance["bindings_sha256"]:
        parser.error("Binding changed; review it and use --update-provenance for an intentional rebuild")
    try:
        sdk = args.sdk.expanduser().resolve() if args.sdk else download_sdk(args.cache) if args.download_toolchain else None
        if sdk is None:
            parser.error("Pass --sdk PATH, set WASI_SDK_PATH, or use --download-toolchain; no global installation is needed")
        compiler = sdk / "bin" / "clang++"
        version = subprocess.run([str(compiler), "--version"], capture_output=True, text=True, check=True).stdout.splitlines()[0]
        if "23.1.0-wasi-sdk" not in version:
            parser.error("This binary is pinned to the compiler in WASI SDK 34 (23.1.0-wasi-sdk)")
        sources = sorted(str(path.relative_to(ROOT)) for path in (VENDOR / "upstream/src/ruckig").glob("*.cpp"))
        with tempfile.TemporaryDirectory(prefix="ossm-ruckig-build-") as directory:
            output = Path(directory) / "ruckig-core.wasm"
            command = [str(compiler), *FLAGS, "vendor/ruckig/bindings.cpp", *sources,
                       *LINK_FLAGS, *[f"-Wl,--export={name}" for name in EXPORTS], "-o", str(output)]
            subprocess.run(command, cwd=ROOT, check=True)
            digest = sha256(output)
            if not args.update_provenance and digest != provenance["artifact"]["sha256"]:
                parser.error("Rebuilt binary differs from the pinned artifact; existing binary preserved")
            destination = ROOT / provenance["artifact"]["path"]
            destination.write_bytes(output.read_bytes())
            if args.update_provenance:
                provenance["bindings_sha256"] = binding_hash
                provenance["artifact"].update(sha256=digest, bytes=destination.stat().st_size)
                provenance["build"].update(compiler=version, flags=list(FLAGS), link_flags=list(LINK_FLAGS), exports=list(EXPORTS))
                PROVENANCE.write_text(json.dumps(provenance, indent=2) + "\n")
                adapter = ROOT / "virtual_synth/static/ruckig-core.js"
                adapter.write_text(re.sub(r"ruckig-core\.wasm\?v=[0-9a-f]+", f"ruckig-core.wasm?v={digest[:12]}", adapter.read_text()))
            print(f"Rebuilt {destination.relative_to(ROOT)}: {destination.stat().st_size} bytes; SHA-256 {digest}")
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        parser.exit(1, f"Ruckig build failed: {error}\n")


if __name__ == "__main__":
    main()
