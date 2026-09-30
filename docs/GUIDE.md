# Motion synth guide

Run `./synth --open` from this checkout after installing `requirements.txt` in
`.venv`. The launcher uses that environment when present, otherwise `python3`.
The bridge binds only to `127.0.0.1:8765`; use `--port NUMBER` for another local
port. Browser assets are included locally and need no cloud service or CDN.
Simulation itself uses the Python standard library. Pyserial is required to
enumerate or connect a USB–RS485 adapter.

## Play in simulation

1. Choose a preset or set RATE, STROKE, CENTER and waveform.
2. ARM, then RUN. No serial device is opened in simulation.
3. Set ATTACK/RELEASE and enable envelope-to-stroke to grow/fade the motion with
   GATE. Holding the gate sustains full envelope; closing it starts release.
4. Add a virtual cable from LFO or ENVELOPE to RATE, STROKE, CENTER or POSITION.
   Adjust its signed depth, or remove it. Each destination accepts one cable.
5. STOP OUTPUT disarms and holds the simulated command. It does not return to
   center. Stop before editing the lower/upper command window.

The scope separates the **requested** waveform and the **planned command**.
In hardware mode, a third trace is actual encoder feedback. Simulation does
not invent measured motor feedback. Normalized travel is a fraction of the
selected raw-count window, not a calibrated millimetre or force measurement.

The LFO is bipolar; ENVELOPE is unipolar. Rate modulation is exponential over
two octaves at full cable depth. Stroke modulation adds to the knob value;
center modulation shifts it by up to half the window at full depth. Values are
bounded. Moving center toward an endpoint reduces the usable symmetric stroke.

A POSITION cable replaces the main oscillator's waveform. ENVELOPE maps zero
to the lower stroke endpoint and full level to the upper endpoint; LFO maps
−1…+1 across the same range. Negative depth reverses direction. A POSITION
cable bypasses the implicit envelope-to-stroke route, preventing the same
envelope from being applied twice; an explicit STROKE cable still applies.

AR retriggers from its current level, without resetting to zero. ATTACK and
RELEASE are full-scale envelope transition times; a partial transition takes
proportionally less time. Oscillator phase continues through gate changes.
Envelope zero requests zero stroke at CENTER; it does not disable a drive.
GATE shapes the envelope. RUN controls output. STOP overrides the envelope
instead of waiting for release.

## Listen to the waveform

Expand **Audio preview** at the bottom of the interface. Audio starts muted.
Click **Enable audio**, then ARM and RUN in simulation. Collapsing the panel
keeps audio playing; its status stays visible in the header.
Sound follows the synth while RUN is active; enabling audio never arms, starts
or connects the motor. Volume affects your speakers only. The audio is a guide
to the signal, not a recording or prediction of the motor's sound.

- **Hear movement** turns position into pitch: farther out means a higher note.
  RATE sets the sweep speed, STROKE sets the pitch range, CENTER shifts it, and
  attack/release gradually grows or shrinks that range. Choose **Planned command**
  to hear the limited trajectory, or **Requested wave** to hear its input. A
  held position sounds like a steady note. Neither source is encoder feedback.
- **Hear wave shape** plays the selected sine, triangle, saw or square as an
  audible oscillator. Its frequency is the effective motion rate multiplied by
  1,000 (20–4,000 Hz); loudness follows the effective stroke and available travel
  span. This includes the envelope when routed to stroke, exactly once. It
  previews the main oscillator before motion limiting. A Position cable bypasses
  that oscillator, so this mode becomes silent and asks you to choose
  **Hear movement** instead.

STOP OUTPUT mutes audio immediately. Faults, stale feedback and leaving the tab
also mute it; click Enable audio again after those interruptions. Every fresh
sample schedules an audio-clock fade to silence if updates stop. Reloading
always returns to muted. No microphone or audio files are needed.

Hover over a control, or reach it with Tab, for a short explanation. Tips also
cover the patch points, cable depth/removal and audio controls. Escape dismisses
the current tip. Disabled controls can explain why they are unavailable on hover.

Audio uses the browser's [Web Audio API](https://www.w3.org/TR/webaudio-1.0/).
Its signal mapping and audio lifecycle checks run without a speaker or motor:

```sh
node --test tests/test_virtual_synth_audio.cjs
```

## Sensorless homing

Launch `./synth --allow-motion --open`, select the USB–RS485 port, and click
**Connect**. The **Home** button beside Arm and Run stays greyed out until a
motor is connected. Click it to find both ends, measure the rail travel, and
park halfway between the measured endpoints. Successful homing leaves output
disabled, ready for **ARM**, then **RUN**. **Stop output** cancels homing.
The progress message reports which end is being found or when the motor is
moving to center.

The initial reference uses the native command from
[OSSM ALT's linked OSSM-RS firmware](https://github.com/ossm-rs/ossm-rs/blob/5f4edbd085da07e18f628b88cbad0caa96db269a/ossm-rs/src/motion/mod.rs#L28-L67):
80 RPM, output/stall setting 89, and special function `0x19 = 1`. The drive
finds one end, retreats 36 degrees and resets its coordinate. The bridge then
switches to 7 RPM / 15 RPM/s to measure both contacts in that same coordinate
system. Two native homes alone would erase the reference needed to measure
the distance between the ends.

Each measured contact requires at least half a second of stationary encoder
readings within four counts, substantial pending motion, and elevated output
PWM. The motor backs away 2 mm, verifies release, and touches that end again;
the repeated contact must agree within 128 counts. The second end is measured
the same way. The measured interval must be at least 20 mm and no more than
500 mm under the configured gearing assumption. Time and distance limits stop
a search that does not find an end.

The working window is inset 2 mm from each measured endpoint. The motor parks
at the midpoint of the two contacts, verifies arrival, then inhibits output
and restores the previous output/stall setting. The waveform planner uses
this measured working span, keeping its existing physical velocity and
acceleration limits when converting normalized positions to encoder counts.
A successful Home does not start waveform motion.

The bridge never transmits an absolute position target of zero because that
value resets the drive coordinate. If a target rounds to zero inside the
measured interval, it uses an adjacent valid count instead, an adjustment of
at most one count. The measured rail may cross that reference normally.

The interface displays approximate millimetres using 819.2 encoder counts/mm
(32768 counts/revolution and 40 mm/revolution). The underlying measurement is
encoder distance, not an independent ruler calibration. Output setting 89 and
the PWM contact threshold are drive settings, not calibrated force limits.
The register meanings are documented in the
[vendor manual](https://www.robotanno.com/web/userfiles/download/ACCESSORIES/IntegratedServoMotor/YZ-AIMManual_v2_55.pdf),
physical pages 9, 12–13 and 17.

Home requires a stationary drive with output disabled, no alarm, slave 1 and
gear numerator 0. It accepts Modbus mode 1 or known disabled mode-0 status
values and selects Modbus itself after fresh stationary readings. It does not
change baud or save EEPROM settings. Reconnecting requires Home again. Lost
feedback, missed deadlines, failed release or inconsistent contacts cancel the
sequence; ambiguous motion acknowledgments are never automatically retried.
The implementation is tested with a fake serial rail; physical testing remains
outstanding.

## USB–RS485 connection

The laptop connects to the existing motor through a **USB–RS485 adapter** and
the separately powered motor drive. Select the exact device in the interface;
the application never guesses a port or opens one on startup. Connect sends
FC03 status reads only at the existing 19200 baud, 8N1, slave 1. It does not
change drive mode, baud, gearing, coordinates or saved configuration. An
observed enabled drive is not silently taken over or stopped.

Connector notes and unresolved motor-pin differences are documented in the
[original hardware project](https://github.com/lucy-chapar/OSSM-Synth/blob/main/MVP.md).
Match the adapter and actual drive before wiring. Motor power
does not come from the laptop's USB port. Physical stop hardware remains
independent of this application.

Live operation requires launching explicitly with:

```sh
./synth --allow-motion --open
```

This enables the browser's explicit Home and Run workflow. It still does not
connect, home, arm or move automatically. Home establishes the reference and
fixed working window described above. The window persists across stopped runs
on that connection. ARM verifies three fresh stationary, inhibited readbacks
before accepting it. Reconnecting requires Home again.

RUN clears pending motion, checks stationary disabled readback, enables the
drive and checks the enabled hold before sending bounded targets. The planner
uses the existing conservative maximum velocity of 3822 counts/s and maximum
acceleration of 8192 counts/s². It bounds position, speed and acceleration;
**jerk limiting is not implemented**. Waveforms with abrupt corners therefore
produce different requested and planned traces, and drive interpolation is
not modeled. Physical performance is not established by the simulation.

Hardware target/feedback cycles run at most 10 Hz, independent of browser
animation. Each run lasts at most 20 seconds. The old 19200-baud transaction
budget is retained; a fast UI or oscillator does not imply high motor bandwidth.
Tracking error over 1024 counts for three samples, drive faults, configuration
changes, communication failures and missed scheduling deadlines latch a fault.
Targets are never retried after an ambiguous write acknowledgment.

## Stop, disconnect and recovery

The active browser tab sends a heartbeat. Losing that tab or its heartbeat for
1.5 seconds disarms and attempts clear/inhibit. A delayed waveform tick over 250 ms stops instead of sending a catch-up
queue. Homing uses a one-second scheduling deadline for its staged transactions. Only the tab that
armed a run may keep it alive or change its controls; another authenticated
local tab may request a stop. Backgrounding the control tab stops its heartbeat.

STOP, a fault, or normal run completion independently attempts clear and inhibit,
then checks three stationary disabled readbacks. A failed clear acknowledgment
does not prevent an inhibit attempt. Failure remains **stop unconfirmed**;
disconnecting or clicking reset must not relabel it as a confirmed stop. A new
explicit connection with fresh disabled/zero-pending/zero-PWM readback is needed
to resolve that uncertainty in the application.

A USB disconnection, sleeping laptop, crashed process or lost motor bus can
prevent software cleanup. The browser's STOP is a software command; physical
stop/power isolation remains independent. No flashing or real motor commands
were performed while implementing this application.

## Local bridge and development

The server accepts loopback Host values, rejects cross-origin requests, requires
a per-tab token for control actions, serves only an explicit asset list and
does not expose arbitrary register writes. It is a local development bridge,
not a network or multi-user service. Do not proxy it onto a public interface.
The runtime does not save serial paths, raw hardware captures or control tokens
to tracked files.

```sh
.venv/bin/python -m unittest discover -s tests -v
```

New tests cover patching/envelopes, trajectory reversals, controller ownership
and deadlines, malformed web requests, and fake Modbus responses/stop failures.
No test needs a serial device. This repository contains the laptop instrument
only; Pi services, CV firmware and CAD live in the original hardware project.

Runtime references: [Python HTTP server](https://docs.python.org/3/library/http.server.html)
and [pySerial API](https://pyserial.readthedocs.io/en/latest/pyserial_api.html).
