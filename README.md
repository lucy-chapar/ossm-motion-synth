# OSSM Motion Synth

A patchable motion instrument in your browser. Shape a waveform, connect virtual
modulation cables, hear the signal, and control an OSSM through a laptop and
USB–RS485 adapter.

This is the standalone web synth spun out of
[OSSM-Synth](https://github.com/lucy-chapar/OSSM-Synth). It includes the browser
interface and local Python bridge. No Raspberry Pi, CV board or firmware flash
is needed.

## Run locally

Requires Python 3.11 or later.

```sh
git clone https://github.com/lucy-chapar/ossm-motion-synth.git
cd ossm-motion-synth
python3 -m venv .venv
.venv/bin/python -m pip install .
./synth --open
```

The interface opens at **http://127.0.0.1:8765** in simulation mode. Choose a
preset, then **Arm → Run**. Use `--port NUMBER` if that port is already in use.
The installed `ossm-motion-synth` command and `python -m virtual_synth` launch
the same application. On Windows, use `.venv\Scripts\python -m pip install .`
and `.venv\Scripts\python -m virtual_synth --open` after creating the environment.

- Sine, triangle, saw and square waveforms with rate, stroke and center controls.
- A patch bay connecting LFO and attack/release envelope to rate, stroke, center
  or position, with positive and negative cable depth.
- A scope showing requested and planned motion, plus encoder feedback when connected.
- Lower and upper travel controls, hover help, and a collapsible audio preview.
- USB–RS485 connection, sensorless homing of both rail ends, measured travel,
  and parking at center before waveform motion.

## Connect an OSSM

```sh
./synth --allow-motion --open
```

Select the adapter, then **Connect → Home → Arm → Run**. Home stays disabled
until a motor is connected. Connection reads status; Home finds both ends and
parks at the measured center. Run starts the waveform. The bridge uses 19200
baud, 8N1, slave 1 and never selects a port automatically.

The bridge retains bounded trajectories, 20-second hardware runs, feedback
checks and stop-on-lost-heartbeat behavior. Sensorless rail measurement has
offline test coverage; physical validation is still outstanding. **Stop output**
is a software command, separate from physical stop/power isolation.

See the [guide](docs/GUIDE.md) for audio mappings, patch behavior, homing details,
connection requirements and recovery behavior.

## Development

```sh
.venv/bin/python -m unittest discover -s tests -v
node --test tests/test_virtual_synth_audio.cjs
```

Tests use fake serial devices and require no motor. Node.js is needed only for
the audio tests; there is no frontend build step. The Python package includes
all browser assets and runs without a CDN.

The optional Python bridge binds to loopback and accepts only same-origin
control requests. The website edition connects directly to a USB–RS485 adapter
through Web Serial; it does not require the Python bridge.

## License

[MPL-2.0](LICENSE). See [NOTICE.md](NOTICE.md) for provenance and acknowledgements.
