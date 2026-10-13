# Licensing and acknowledgements

OSSM Motion Synth source and documentation are licensed under the Mozilla
Public License 2.0. See [LICENSE](LICENSE).

This project was extracted from
[lucy-chapar/OSSM-Synth](https://github.com/lucy-chapar/OSSM-Synth), retaining its
browser synth, motion engine, laptop bridge and tests. The internal protocol
helpers in `virtual_synth/protocol/` and offline fixtures are extracted from
that project's MPL-2.0 motor tools. Browser engine and Web Serial modules are
JavaScript ports of those Python implementations. Bench command-line applications, Pi
services, hardware designs, CV firmware and commissioning records are excluded.

The synth integrates with the
[KinkyMakers OSSM project](https://github.com/KinkyMakers/OSSM-hardware).
The OSSM name and upstream designs and firmware retain their own licenses.
Vendor manuals and hardware drawings are referenced, not bundled.

The original Python sensorless-homing implementation references the YZ-AIM
vendor protocol and the sequence in
[OSSM-RS](https://github.com/ossm-rs/ossm-rs/blob/5f4edbd085da07e18f628b88cbad0caa96db269a/ossm-rs/src/motion/mod.rs),
the Apache-2.0 firmware linked by
[OSSM ALT Edition](https://github.com/jollydodo/OSSM-ALT-Edition).
No Rust source from that project or its GPL-3.0 successor is bundled here.

[pySerial](https://github.com/pyserial/pyserial) retains its own license.

The local WebAssembly motion core bundles unmodified calculation source from
[Ruckig Community 0.15.3](https://github.com/pantor/ruckig/tree/37b6e7a4c60f5befd2506741d5f7d0ae7eefb3db),
MIT licensed, copyright 2021 Lars Berscheid. The source, license, binding, exact
build recipe and hashes are retained in `vendor/ruckig/`. The compiled core also
contains WASI libc/libc++ runtime portions with their upstream licenses.
See `ruckig-LICENSE.txt` in the exported browser app, or
`virtual_synth/static/ruckig-LICENSE.txt` in the source checkout, for the full
Ruckig and runtime license notices. The core runs locally without the Ruckig
cloud client. Our integration files retain MPL-2.0 licensing.

Firmware binaries, vendor documents, private recordings,
Wi-Fi configuration and credentials are not included in this repository.
