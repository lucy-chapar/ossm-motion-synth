# Motion synth guide

The [website edition](https://lucychapar.com/ossm-motion-synth/) runs the engine,
audio and USB–RS485 control directly in the browser using Web Serial. In desktop
Chrome or Edge, expand **Motor connection** and click **Connect**. The browser
asks you to choose your USB–RS485 adapter, then connects to it.
No adapter opens automatically. The controls and rail measurement sequence
are shared with the optional Python edition; drive startup handling differs
as noted below.

**Wiring:** With power off, disconnect the 4-pin signal cable that runs to the
OSSM motherboard. This setup only needs 24 V power and USB–RS485 wired directly
to the motor.

For the Python edition:

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

On the website, choose your USB–RS485 adapter and click **Connect**. With the
optional Python bridge, first launch `./synth --allow-motion --open` and select
the USB–RS485 port. The **Home** button beside Arm and Run stays greyed out until a
motor is connected. Click it to find both ends, measure the rail travel, and
park halfway between the measured endpoints. Successful homing leaves output
disabled, ready for **ARM**, then **RUN**. **Stop output** cancels homing.
The progress message reports which end is being found or when the motor is
moving to center.

The browser measures both ends directly in the existing encoder coordinate,
at 35 RPM / 75 RPM/s with output/stall setting 89. It does not invoke the
native coordinate-reset command. Each search is bounded to 500 nominal mm.
The optional Python bridge retains its native reference stage.

Each measured contact requires at least half a second of stationary encoder
readings within four counts, substantial pending motion, and elevated output
PWM. The motor backs away 2 mm, verifies release, and touches that end again;
the repeated contact must agree within 128 counts. The second end is measured
the same way. The measured interval must be at least 20 mm and no more than
500 mm under the configured gearing assumption. Time and distance limits stop
a search that does not find an end.

After inhibition, the browser allows up to 512 counts of inward springback
before the 2 mm retreat. The loaded contact repeat tolerance remains 128
counts. It clears pending demand while inhibited before enabling each stage.

The working window is inset 2 mm from each measured endpoint. The motor parks
at the midpoint of the two contacts, verifies arrival, then inhibits output
and restores the previous output/stall setting. The waveform planner uses
this measured working span, keeping its existing physical velocity and
acceleration limits when converting normalized positions to encoder counts.
After parking, browser Home restores 150 RPM and acceleration register 60000.
The vendor documents 60000 as disabling the drive's internal acceleration
curve. The browser plans acceleration itself; applying a second drive ramp
would add position lag. The Python bridge retains its earlier profile.
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

In the browser edition, Home accepts a stationary drive in Modbus mode or a
recognized step/direction position mode, including the normal enabled startup
state. It checks fresh encoder and speed readings, inhibits the drive, selects
Modbus, and sets gear numerator 0 before applying the homing profile. Connect
alone only reads status. An alarm, unknown operating mode or moving encoder
prevents Home from starting.

The optional Python bridge still requires output disabled and gear numerator 0
before Home. Neither edition changes baud or saves EEPROM settings.
Reconnecting requires Home again. Lost feedback, missed deadlines, failed
release or inconsistent contacts cancel the sequence; ambiguous motion
acknowledgments are never automatically retried.

The browser accepts at most two counts of disabled feedback quantization,
with zero PWM and three stable encoder readings. A connected-motor check on
2026-09-30 at the earlier 7 RPM probe speed measured approximately 180 mm of travel and parked within 0.1 mm
of the measured center with output inhibited. Two successive published-version
Home checks agreed within one encoder count of travel (147216 and 147215
counts). A slow sine run completed its timer without a fault; a separate
manual Stop also confirmed disabled output and zero PWM. These checks cover
one connected drive, not every motor or adapter. The subsequent 35 RPM /
75 RPM/s Home completed with 147220 counts of travel and a stopped position
72 counts from center.

## USB–RS485 connection

The laptop connects to the existing motor through a **USB–RS485 adapter** and
the separately powered motor drive. Select the exact device in the interface;
the application never guesses a port or opens one on startup. Connect sends
FC03 status reads only at the existing 19200 baud, 8N1, slave 1.
It drains stale adapter input on opening and requires a quiet receive boundary
between commands; response CRC errors still fail the transaction without a
command retry. It does not
change drive mode, baud, gearing, coordinates or saved configuration. An
observed enabled drive is not silently taken over or stopped.

Connector notes and unresolved motor-pin differences are documented in the
[original hardware project](https://github.com/lucy-chapar/OSSM-Synth/blob/main/MVP.md).
Match the adapter and actual drive before wiring. Motor power
does not come from the laptop's USB port. Physical stop hardware remains
independent of this application.

Live operation through the optional Python bridge requires launching explicitly with:

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
uses a browser maximum velocity of 73728 counts/s (90 nominal mm/s) and
maximum acceleration of 147456 counts/s² (180 nominal mm/s²), with ten percent
speed headroom below the drive's 150 RPM setting. The optional Python bridge
retains 3822 counts/s and 8192 counts/s². It bounds position, speed and acceleration;
**jerk limiting is not implemented**. Waveforms with abrupt corners therefore
produce different requested and planned traces, and drive interpolation is
not modeled. Physical performance is not established by the simulation.

Hardware target/feedback cycles run at most 10 Hz, independent of browser
animation. Each run lasts at most 20 seconds. The browser allows 200 ms per 19200-baud transaction; a fast UI or oscillator does not imply high motor bandwidth.
Browser tracking error beyond one command interval of travel plus 1024 counts,
capped at ten percent of the working span, for three fresh samples, drive faults, configuration
changes, communication failures and missed scheduling deadlines latch a fault.
Targets are never retried after an ambiguous write acknowledgment.

## Stop, disconnect and recovery

The active browser tab sends a heartbeat. Losing that tab or its heartbeat for
1.5 seconds disarms and attempts clear/inhibit. A delayed waveform tick over 250 ms stops instead of sending a catch-up
queue. Homing uses a one-second scheduling deadline for its staged transactions. Only the tab that
armed a run may keep it alive or change its controls; another authenticated
local tab may request a stop. Backgrounding the control tab stops its heartbeat.

STOP, a fault, or normal run completion independently attempts clear and inhibit,
then allows up to 1.5 seconds to settle and checks three stationary disabled
readbacks. Normal browser runs stop just before the independent 20-second
transport deadline. A failed clear acknowledgment
does not prevent an inhibit attempt. Failure remains **stop unconfirmed**;
disconnecting or clicking reset must not relabel it as a confirmed stop. A new
explicit connection with fresh stationary disabled/zero-PWM readback is needed
to resolve that uncertainty in the application.

A USB disconnection, sleeping laptop, crashed process or lost motor bus can
prevent software cleanup. The browser's STOP is a software command; physical
stop/power isolation remains independent.

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

### Connected-drive pattern check, 2026-10-01

A background test using the browser runtime and Web Serial transport through
the USB–RS485 adapter completed a 20-second, 0.25 Hz sine at 70% stroke without
a fault. Encoder feedback covered approximately 98 mm against approximately
100 mm requested on the measured 179.7 mm rail. A triangle pattern and manual
Stop also completed without a fault. Stop readbacks confirmed output
inhibited, zero PWM and stationary encoder feedback. This verifies one drive
and adapter through a direct serial harness, not the deployed Chrome session.
Intermittent response timeouts were also observed during this session; they
remain latched faults and never cause automatic motion retries.
