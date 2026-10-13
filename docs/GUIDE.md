# Motion synth guide

The [website edition](https://lucychapar.com/ossm-motion-synth/) runs the engine,
audio and USB–RS485 control directly in the browser using Web Serial. In desktop
Chrome or Edge, expand **Motor connection** and click **Connect**. The browser
asks you to choose your USB–RS485 adapter, then connects to it.
A previously permitted adapter can reconnect when exactly one saved USB identity
matches; connection does not Home or Play automatically. The controls and rail
measurement sequence are shared with the optional Python edition. The browser hardware planner differs from that edition as noted below.

The October 13 revision uses continuous jerk-limited trajectories. Use
`./synth-web --open` from the repository to rebuild and serve it at
`http://127.0.0.1:8769/`. The
[planner audit](MOTION_PLANNER_AUDIT.md) records the continuous-state design and
earlier 19200-baud / 20000 RPM/s drive trials.

The browser serial path is completion driven, with no fixed 20/50 Hz target
cap. A dedicated worker owns the planner, watchdog and serial streams; the
page sends controls and displays feedback. The tested drive was separately
commissioned to 115200 baud and power cycled; normal Connect does not change
baud. Home applies `servo_direct`: native acceleration bypass with zero
position feedforward, a fixed position gain of 3000, and unchanged host V/A/J
limits. The [tuning record](TUNING-2026-10-13.md) separates retained ramp/gain
comparisons from worker validation. Earlier link results remain in the
[serial audit](SERIAL_THROUGHPUT_AUDIT.md).

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
2. Click **Play**. No serial device is opened in simulation.
3. Set ATTACK/RELEASE and enable envelope-to-stroke to grow/fade the motion with
   GATE. Holding the gate sustains full envelope; closing it starts release.
4. Add a virtual cable from LFO or ENVELOPE to RATE, STROKE, CENTER or POSITION.
   Adjust its signed depth, or remove it. Each destination accepts one cable.
5. STOP OUTPUT disarms and holds the simulated command. It does not return to
   center. Stop before editing the lower/upper command window.

The scope separates the **requested** waveform and the **planned command**.
The browser shows the resulting requested travel and planned phase rate. A
fixed hardware wave that exceeds the velocity/acceleration/jerk budget runs at
a feasible planned rate to preserve stroke. Square transitions, triangle corners
and saw flyback receive finite jerk-limited time. Position patches show their own
control mode. See the [motion planner audit](MOTION_PLANNER_AUDIT.md).
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
Click **Enable audio**, then **Play** in simulation. Collapsing the panel
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
the USB–RS485 port. **Home** below the motion monitor stays greyed out until a motor
is connected and the motion core is ready. Click it to find both ends, measure
the rail travel, and park halfway between the measured endpoints. Successful
homing leaves output disabled, ready for **Play**. **Stop output** cancels homing.
The progress message reports which end is being found or when the motor is
moving to center.

The browser measures both ends directly in the existing encoder coordinate,
using 70 RPM / 150 RPM/s for long searches and 35 RPM / 75 RPM/s for short
retreat, repeated contact and centering moves, with output/stall setting 89. It does not invoke the
native coordinate-reset command. Each search is bounded to 500 nominal mm.
The optional Python bridge retains its native reference stage.

Each measured contact requires at least half a second of stationary encoder
readings within four counts, substantial pending motion, and elevated output
PWM. The motor backs away 2 mm, verifies release, and touches that end again;
the repeated contact must agree within 128 counts. The second end is measured
the same way. The measured interval must be at least 20 mm and no more than
500 mm under the configured gearing assumption. Time and distance limits stop
a search that does not find an end.

After inhibition, the browser allows up to 819 counts (1 mm) of inward springback
before the 2 mm retreat. The loaded contact repeat tolerance remains 128
counts. It clears pending demand while inhibited before enabling each stage.

The working window is inset 2 mm from each measured endpoint. The motor parks
at the midpoint of the two contacts, verifies arrival, then inhibits output
and restores the previous output/stall setting. The waveform planner uses
this measured working span, keeping its existing physical velocity and
acceleration and jerk limits when converting normalized positions to encoder counts.
After parking, browser Home restores a 1800 RPM ceiling and the selected
profile. The browser default is `servo_direct`: register 3 = 60000 disables
the native acceleration process and selects zero position feedforward. It is
not a 60000 RPM/s acceleration value. Nominal host ceilings remain 1080 mm/s,
6000 mm/s² and 100000 mm/s³. Home sets position gain 3000 only with fresh
stationary, inhibited feedback, verifies the acknowledgement and independent
readback, and locks it into the configuration baseline. It does not save
parameters to EEPROM. An uncertain gain write is never resent.
The `streaming` comparison profile uses 60098 (98% position feedforward, no
internal ramp); its watched 1 Hz test was visibly pulsing. The older `ramped`
profile retains 2000 RPM/s and a 1200 mm/s² host ceiling. The retained
`servo_ramped` comparison uses 50000 RPM/s. Faster requested fixed
waves are retimed to fit their selected budget. The historical 20000 RPM/s
servo-ramped 1 Hz trial reduced sampled speed bursts. Later 19200-baud
continuous-planner acceptance and the current 115200-baud guarded trials are
recorded separately in the [planner](MOTION_PLANNER_AUDIT.md) and
[serial](SERIAL_THROUGHPUT_AUDIT.md) audits.
Centering uses the slower
35 RPM / 75 RPM/s calibration profile. The Python bridge retains its earlier
profile. Modulated patterns can still be limited by the physical budget.
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
the separately powered motor drive. First use requires the browser chooser;
subsequent automatic connection is limited to one previously permitted adapter
matching the saved USB identity. The optional Python bridge still requires
manual port selection. Connect sends
FC03 status reads only, with 8N1 and slave 1. The local browser first checks
19200 baud, then 115200 and 38400 only if the previous rate times out. Each
attempt closes before the next opens. Any valid status ends discovery, including
an alarm or unexpected drive state. Connect does not change the motor's baud.
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

Play clears pending motion, checks stationary disabled readback, enables the
drive and checks the enabled hold before sending bounded targets. The current
local browser retains host limits of **1080 nominal mm/s** and **6000 mm/s²**
and adds **100000 mm/s³ jerk**. These are 884736 counts/s, 4915200 counts/s²
and 81920000 counts/s³ at the assumed 819.2 counts/mm. The `servo_direct`
drive setting is 1800 RPM and register 3 = 60000, with position gain 3000.
The host shapes acceleration and jerk; the native position/speed loops remain
active. Baud commissioning on the tested
drive was a separate explicit operation; Connect itself remains read-only.

The hardware planner carries commanded position, velocity and acceleration
between updates. Startup and changes capture a future moving state through the
local Ruckig core. Intermediate same-direction samples keep their derivatives;
actual reversals stop velocity. Sine endpoints retain their analytic inward
acceleration; finite-leg endpoints use their planned derivatives. Triangle, square and saw
use finite jerk-limited legs, and fixed sines are retimed against velocity,
acceleration and jerk demand. Their references reserve 95% of each host limit
for capture headroom. Full trajectory extrema and jerk-aware stopping paths
must fit the permitted rail corridor. This planned state is distinct from
actual encoder motion and does not establish the drive's interpolation behavior.

The local WASM asset loads asynchronously at browser startup; Home and Play
remain unavailable until it is ready. Planning then runs synchronously offline,
without a CDN or cloud trajectory service. See [core build and API notes](../vendor/ruckig/README.md)
and [licensing](../NOTICE.md). Simulation and the optional Python bridge retain
the original point planner; the bridge still uses 3822 counts/s and 8192
counts/s² and has no jerk limit.

Fixed-wave rate formulas do not prove fidelity for modulation. Modulated motion
uses finite PVA captures; clipping or infeasible changes can alter the planned
stroke or phase, require a bounded braking transition, or fault. The scope's
commanded trace and planned rate describe the model, not achieved servo speed.

Browser target updates are completion driven: after a transaction finishes,
the runtime prepares the next current target, with one exchange outstanding
and no fixed rate cap or queue of missed positions. The live trajectory is
sampled after the serial queue and quiet-line waits, immediately before native
submission. Stop and guard freshness are rechecked around that resolver; the
actual replacement frame is validated before writing. All supported baud rates
reuse fresh status groups. At 115200, a single complete snapshot refreshes all
guards every 100 ms. At 19200/38400, partial refreshes are phased after a full snapshot and
become due 100 ms after each subsequent receipt. Normally one due group is
read; further due groups are drained when any remaining group has 100 ms or
less before the hard age limit. The four groups still cover every checked
register, and any group older
than 250 ms prevents a target before the native write. Connect, Home, arming and
Stop retain complete snapshots. The planner advances the waveform and modulation
in steps of at most 2 ms internally; only the final current target reaches the
wire. Final sampling also advances across synchronous planning work. Unsent
path length, including reversals, is bounded across those advances; exceeding
the existing following corridor rejects the next target before submission.
Only successful current-epoch target completion advances that anchor.
The previous 50 ms cycles at 19200/38400 and 20 ms cycles at 115200 are
historical, not current limits.

Ordinary exchanges and transitions to/from FC7b retain a 2 ms idle boundary
measured from the last received chunk. Time already spent quiet satisfies that
boundary. Consecutive clean FC7b exchanges add no post-response delay. Startup
and error recovery keep their longer stale-input quarantine; malformed replies
are still rejected without retrying uncertain targets. Scope history samples
at roughly 50 Hz and retains ten seconds independently of serial cadence and
UI/state polling. `command_reply_rate_hz` reports a bounded one-second estimate
of completed target replies/s, including intervening guard transactions; it is
not motor RPM, pattern Hz, or an encoder velocity measurement.

The optional Python bridge retains its 10 Hz hardware cycle. Browser runs continue
until Stop, a disconnect or a monitored fault. Serial and adapter completion
still bound achieved throughput; the supported 115200 baud does not guarantee
500 Hz delivery. See [measured link results and commissioning](SERIAL_THROUGHPUT_AUDIT.md).
Browser tracking error beyond 100 ms of ceiling-speed travel plus 1024 counts,
capped at ten percent of the working span, for three fresh samples, drive faults, configuration
changes, persistent communication failures and missed scheduling deadlines latch a fault.
Targets are never retried after an ambiguous write acknowledgment.

## Stop, disconnect and recovery

The active browser tab sends a heartbeat. Losing that tab or its heartbeat for
1.5 seconds disarms and attempts clear/inhibit. A delayed waveform tick over 250 ms stops instead of sending a catch-up
queue. Homing uses a one-second scheduling deadline for its staged transactions. Only the tab that
armed a run may keep it alive or change its controls; another authenticated
local tab may request a stop. Backgrounding the control tab stops its heartbeat.

STOP, a fault, or normal run completion independently attempts clear and inhibit,
then allows up to three seconds to settle and checks three stationary disabled
readbacks. Normal browser runs have no elapsed-time limit; the optional Python bridge retains its 20-second
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
Intermittent response timeouts were also observed during that session. Its
recovery behavior predates the current continuous planner; the fail-closed
active-pattern policy is described below. Uncertain motion targets are never resent.

### Brief glitches and reconnecting

During an active browser pattern, a recovered guard reply or uncertain target
acknowledgment now **stops and inhibits the run**. A moving PVA reference cannot
be frozen during an uncertain interval and resumed as if it stayed on its path.
Recovery can read fresh status; it never retransmits an uncertain target or
queues missed points. After confirmed Stop, reset the fault if needed, then
Play again from fresh stationary feedback. Bounded read-only recovery remains
available for connection and Stop verification. Failed writes, closed streams,
drive alarms, changed configuration and out-of-range feedback still fault.

After a confirmed stop from a communication fault, **Reset fault** checks three
fresh stationary readings and lets you Arm again on the same connection,
retaining the measured rail. USB unplug releases the old port automatically.
Reconnect checks the drive and, if the previous stop was unconfirmed and output
is still enabled, inhibits it and verifies stationary feedback. A new USB
connection requires Home again. Reconnection never starts motion automatically.

Historically, an October 1 connected-drive test discarded one status reply and
one target acknowledgment during a 20-second sine. Both recovered and the run
completed with confirmed inhibition under the earlier resume policy. That result
is retained as historical evidence, not acceptance of the current fail-closed
continuous-motion policy or a test of physical USB unplug during motion.

After a confirmed stop, disabled encoder position may settle up to 1 nominal mm
from that fixed stop position. The reference does not move with later readings,
so gradual drift cannot accumulate indefinitely. Enabled output, PWM, speed,
changed configuration and travel-bound violations are still rejected. Stop and
Arm still require three stable readings. A stopped-feedback error now reports
the position displacement, pending counts, speed, PWM and output word.

The browser's everyday slider ranges are 0.02–2.5 Hz for Rate, 0.01–0.3 Hz for
LFO, and 0.2–5 seconds for Attack and Release. Stroke and Center retain their
full percentage ranges. The underlying engine accepts the previous parameter
range for compatibility. These control ranges improve adjustment resolution;
wide strokes and combined modulation can still engage the motion limiter.

Stop verification tolerates a dropped status reply within its three-second
deadline, then requires three fresh stable inhibited readings. Pressing Stop
again after failed cleanup makes a new inhibit/verification attempt; it never
restarts motion. The fault banner retains the original fault and cleanup error.


### Browser pause and reconnection

Play changes to Pause while running. Pause inhibits output and verifies the stop,
then freezes the carrier, LFO and envelope phase. Resume takes fresh stationary
encoder feedback, enables the drive, and captures the paused pattern through
a continuous PVA trajectory with velocity, acceleration and jerk limits. Stop output ends the paused session.

After a successful connection, the browser remembers the adapter USB identity.
On page load or USB attachment it reconnects only if exactly one previously
permitted adapter matches. Identical adapters require manual selection. First
use still requires the browser chooser; automatic connection never starts motion
or restores calibration. Home and Play remain explicit after reconnection.

Browser homing uses 70 RPM / 150 RPM/s for the long endpoint searches.
Center parking, short retreat and repeated contact checks retain 35 RPM /
75 RPM/s. Output limit, contact confirmation, repeat agreement, search bounds
and stop verification are unchanged. The faster homing profile has passed the connected rail check.

Stop verification now permits up to three seconds for inhibited feedback to settle.
Three stable encoder readings and disabled-output, speed, pending and PWM checks
remain required. A failure includes the last feedback fields and encoder spread.

The browser Rate control reaches 2.5 Hz. Wide high-rate patterns can still exceed
the motion budget; the tested faster profile is described below.


The browser controls are Connect → Home → Play. Play performs the same
fresh stationary arming checks internally before enabling motion. It changes
to Pause while running and Resume while paused. Stop ends the session and
inhibits output. Connecting and homing never automatically start a pattern.


### Current local browser hardware planner

The browser uses the same dedicated `0x7b` absolute-position command as the
upstream OSSM-alt motor library. Its eight-byte reply carries the current encoder
position (low word, then high word), not a target echo; this was checked on the
connected drive with output inhibited and a distinct target. Homing retains
the established bulk-register position commands. Completion-driven scheduling,
guard freshness and recovery are described above. The immediate encoder reply
is checked against the preceding accepted target,
matching the connected drive's observed response timing. A stuck or excessively
lagging encoder still faults after three fresh samples.

The browser selects `servo_direct`, with native acceleration bypass and zero
feedforward. The host retains its 6000 mm/s² ceiling. Earlier ramp and
98% feedforward comparisons are retained separately; see
[the tuning record](TUNING-2026-10-13.md).
The October 13 continuous-planner revision passed 267/267 browser checks, including 13 core checks;
500 independent native/WASM trajectories agreed within 1.31e-13. These are
software checks. The earlier watched 19200-baud / 20000 RPM/s 1.5 Hz sine was
accepted as smooth, and its browser Home/Play/Stop passed. Earlier guarded
115200-baud trials completed a 1.5 Hz / 70% sine, a 2.5 Hz / 30% sine and a
2.5 Hz / 37.9% requested saw, with the saw retimed to 1.905 Hz. Each confirmed
Stop. Those runs used production browser modules through an exclusive Node
serial harness. The final Chrome Home → Play → Stop check also passed,
displaying 80–85 command updates/s for the saw and confirmed Stop afterward.
The current revision passes 376 browser tests and 134 Python tests. Other loads and
stock-firmware parity remain unverified. See the
[current serial audit](SERIAL_THROUGHPUT_AUDIT.md),
[earlier planner results](MOTION_PLANNER_AUDIT.md) and
[historical motion results](MOTION_SMOOTHING.md).

Stop confirmation observes at least 600 ms and requires three fresh stationary,
inhibited readings within 0.1 mm. Following a confirmed stop, speed/demand-only
settling discrepancies receive up to six read-only rechecks 100 ms apart, provided
output and PWM stay zero and displacement stays within the fixed 1 mm limit.
Persistent demand, speed, output, PWM, configuration or drift contradictions still
fault. No motion targets are resent by settling recovery.

Before Home or Play, inhibited speed feedback receives the same bounded read-only
settling retries. Arming requires three stationary samples within a 1.5-second
window; persistent inconsistent feedback still prevents motion.

Center parking permits up to 409 counts (0.5 mm) of post-inhibit settling around
the fixed center target. Three stationary readings and inhibited output remain
required; this does not change the loaded endpoint repeat tolerance.
