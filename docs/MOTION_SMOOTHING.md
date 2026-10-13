# Browser motion smoothing — historical trials and October 13 continuation

The current **local, not deployed** defaults and guarded physical results are
recorded in the [serial throughput audit](SERIAL_THROUGHPUT_AUDIT.md). The
[October 13 motion planner audit](MOTION_PLANNER_AUDIT.md) describes the C2
planner and earlier 20000 RPM/s trials, superseding the position-only tracker
below. Historical user acceptance applies only to its recorded pattern, load
and earlier implementation.

## October 2–3 changes and results (historical)

These entries retain the actual earlier attempts and their validation limits,
including the lack of jerk limiting at that time. Historical benchmark values
are not expected to reproduce unchanged after the October 13 planner replacement.

Local development against `0ad919ebf362c7a617ffeb46c92cbaffa42aa5dd`.
This revision is local and has not been deployed. Connected tests are recorded
below; steady command timing alone did not remove the user-observed pulsing.

The previous live QA recorded 21.5 ms median target intervals, with 64.1 ms
at the 95th percentile and 74.8 ms maximum. A complete status exchange needs
65 wire bytes, or 33.85 ms at 19200 baud before quiet gaps and USB latency.
The runtime also generated its target before that status read, so the position
could already be stale when transmitted. See [retained physical QA](QA-2026-10-02.md).

## Changes

- Four rotating short status reads replace the long running snapshot. Every
  register remains checked, with a 250 ms maximum age enforced before the target
  and again immediately before native transmission. Complete snapshots remain
  in Connect, Home, arming, Stop and read-only recovery.
- Target cycles use 50 ms wall-clock deadlines. Serial completion does not add
  another full cycle delay. Missed positions never accumulate in a catch-up queue.
- The waveform is sampled after the status read. Heartbeat, scheduling deadline
  and Stop intent are rechecked before generating a target. Stop is checked again
  after the serial quiet gap, immediately before submitting a native write.
- Hardware waveform and modulation advance internally in steps of at most 2 ms.
  Reference and planned position are compared at the same midpoint, avoiding
  cadence-dependent overshoot. Only the final current point is transmitted.
- Fresh fast-position feedback is compared with the preceding accepted target.
  Connected replies followed that point before the servo could reach the newly
  sent point. Comparing with the new point caused a false fault during the fast
  sine trial. Captured replies and a stuck-encoder case now cover this behavior;
  the tracking tolerance and three-sample fault rule remain unchanged.
- A fixed `ramped` transport profile enables the drive's internal acceleration
  ramp at 2000 RPM/s and reports a matching 1200 nominal mm/s² planner ceiling.
  The local browser selects this trial profile; `streaming` remains the transport
  default for explicit callers. Profile checks
  are exact; Home and cancellation restore the selected profile while inhibited.

Drive mode, baud, velocity ceiling, calibrated travel guards and stationary Stop
verification are retained. The ramped profile lowers the acceleration ceiling.
This does not add a jerk limit or
establish the drive's interpolation behavior between targets.

## Offline results

187 browser tests pass with test files run sequentially. A concurrent rerun hit
the existing timer-sensitive continuous-noise fixture; its timer cleanup now
releases every interval even when an assertion fails. The final sequential run
passed all assertions. The earlier 132-test Python pass is retained; Python
server tests required loopback socket access. The standalone browser export and its asset hashes were
verified. New coverage includes irregular waveform timing, amplitude fidelity,
stopping bounds, short-response framing, all status groups, stale guards,
read-only recovery, transaction-aligned tracking and Stop during pending writes.

The reproducible tracker sweep uses a nominal 179.7 mm working span, the existing
1080 mm/s and 6000 mm/s² limits, 16 seconds per sine, and excludes the first three
seconds. Its interval sequence ranges from 19 to 74.8 ms. These are requested
versus planned-command errors; they are not encoder measurements.

| Pattern | Requested span | Previous command span | New command span | Previous RMS error | New RMS error |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1.5 Hz / 70% sine | 100.629 mm | 108.064 mm | 101.047 mm | 4.111 mm | 0.276 mm |
| 2.5 Hz / 30% sine | 43.128 mm | 46.087 mm | 43.353 mm | 4.286 mm | 0.219 mm |

The serial model uses 19200 baud, ten bits per byte, a 3 ms quiet gap and an
assumed 10 ms adapter overhead per exchange. Across 200 targets, median spacing
is 50 ms, maximum spacing is 52.083 ms, and maximum status-group age is 198.396 ms.
This model includes the production runtime and transport. It excludes browser
timer jitter and servo dynamics, and does not establish a measured motor cadence.

Reproduce from the repository root:

```sh
node --test --test-concurrency=1 tests/*.cjs
python3 -m unittest discover -s tests
node scripts/benchmark_tracking.cjs --baseline 0ad919e
node scripts/benchmark_streaming.cjs
python3 scripts/export_web.py --output dist/web
```

## Connected results

The production JavaScript runtime, transport and serial framing were connected
to the USB–RS485 adapter through a private native serial pipe. This exercises
the connected drive but does not measure a browser's event-loop timing.
Fresh direct Home measured 181.39 nominal mm of travel.

| Streaming trial | Duration | Median target interval | P95 interval | Maximum interval | Final Stop |
| --- | ---: | ---: | ---: | ---: | --- |
| 0.25 Hz / 30% sine | 10 s | 49.94 ms | 52.72 ms | 53.88 ms | Confirmed |
| 0.5 Hz / 70% sine | 10 s | 49.90 ms | 53.03 ms | 54.65 ms | Confirmed |
| Ramped 0.25 Hz / 30% sine | 10 s | 50.17 ms | 52.94 ms | 54.32 ms | Confirmed |
| Ramped 0.5 Hz / 70% sine | 10 s | 50.02 ms | 53.32 ms | 54.45 ms | Confirmed |

The broad trial also completed a one-second Pause and five-second Resume with
frozen phase during Pause. Neither trial had communication recovery. The user
reported that the slow sine still pulsed or jittered. The 1.5 Hz trial stopped
on the incorrect new-target feedback comparison described above, with output,
pending demand, PWM, speed and alarm all zero afterward. It does not establish
fast-pattern performance.

The ramped attempt repeated fresh Home, measuring 181.45 nominal mm. Both
ten-second runs completed without a fault or communication recovery, with
maximum status-check ages below 192 ms. Final output, pending demand, PWM and
alarm were zero; the speed estimate was -1 RPM, within the existing stationary
tolerance. The adapter was closed and released. These are operation and Stop
checks; they do not establish improved perceived smoothness.

Compared with streaming, encoder error relative to the preceding accepted
target increased from 0.088 to 0.482 mm RMS for the slow sine and from 0.386 to
6.067 mm for the moderate sine after excluding the first two seconds. The drive
ramp therefore changes motion and adds following lag. Target-to-reply latency
remained approximately 13 ms in both profiles. Faster requested patterns can be
limited by the lower acceleration ceiling.

## Further connected validation

Compare the profiles with the same adapter, motor, rail and settings.
Begin with a supervised ten-second slow sine and confirm Stop. Then test the
1.5 Hz / 70% and 2.5 Hz / 30% patterns in separate ten-second runs, including
Pause/Resume and confirmed final inhibition. Record actual command intervals,
encoder span and lag, overshoot, status ages and any communication recovery.
Judge motion from the physical run and encoder trace; the offline curves alone
cannot sign off smoothness. The 2000 RPM/s ramped profile can follow the two
slow/moderate patterns above, but the previous 1.5 Hz / 70% pattern exceeds its
acceleration budget. Retain the current live release until connected comparison
supports a production profile.

## October 3 continuation

Two further ten-second ramped sines reported complete encoder strokes and final
inhibition through the native serial pipe. The user reported no visible motion,
then restarted the machine. These runs therefore do not establish physical
movement or improved smoothness; a watched repeat is required.

Measured complete guard-plus-target cycles took 39.84 ms median / 43.62 ms
maximum for the slow sine and 38.29 ms median / 49.21 ms maximum for the moderate
sine. Raising the target rate at 19200 baud would exhaust the observed budget.
Fresh read-only snapshots after the restart found normal step/direction startup
mode, enabled holding output, zero speed/PWM/pending demand/alarm, and a stable
encoder. Home/calibration from the earlier connection is invalid.

The host now supports 19200, 38400 and 115200. Browser Connect tries read-only
status at those rates, closes completely between attempts, and changes rate only
after response timeouts. A valid snapshot ends discovery even if it reports an
alarm or unusual configuration. Corruption, cancellation, opening/closing
failures and uncertain cleanup do not trigger fallback. No motor baud or saved
configuration is changed by Connect.

At verified 115200, the local runtime requests 25 ms deadlines instead of 50 ms.
The same conservative serial model with 10 ms adapter overhead per exchange
delivers approximately 29.73 ms intervals, without a catch-up queue or stale
guards. This model is not a physical cadence claim. A connected 115200 trial is
still required before choosing the production rate/profile.

Changing the motor's baud is a separate persistent commissioning operation,
effective after a power cycle. The [vendor manual, page 18](https://www.robotanno.com/web/userfiles/download/ACCESSORIES/IntegratedServoMotor/YZ-AIMManual_v2_55.pdf)
has inconsistent register numbers; its page 11 map and the
[upstream driver](https://github.com/ossm-rs/ossm-rs/blob/main/ossm-rs/src/motor/m57aimxx/mod.rs#L284-L296)
identify mode/acceleration/weak-magnetism addresses as 0/3/4. No commissioning
sequence has been transmitted to this machine.

All 206 browser tests pass with files run sequentially. The final check includes
baud opening profiles, bounded read-only
discovery, closing/cancellation failures, calibration invalidation, and selected
cadence across Play/Pause/Resume/Stop. Python tests are retained from the earlier
run, not rerun for these JavaScript changes.

## Watched slow sine after restart

With the user watching the carriage, fresh direct Home measured 181.57 nominal
mm of travel and parked at center with output inhibited. One ten-second sine
at 0.25 Hz / 30% stroke then ran using the 2000 RPM/s ramped profile at 19200
baud. The user confirmed: "Moves smoothly."

The run accepted 199 targets. After excluding startup, the planned span was
42.610 nominal mm and encoder span 42.557 mm; encoder lag relative to the
preceding target was 0.499 mm RMS and 0.918 mm at the 95th percentile. Target
intervals were 49.93 ms median, 53.55 ms at the 95th percentile, and 57.27 ms
maximum. Complete guard-plus-target cycles were 39.77 ms median and 51.89 ms
maximum, leaving no evidence for increasing cadence at this baud.

There were no transaction errors or communication recoveries. Final Stop was
confirmed with output, pending demand, PWM, actual speed and alarm all zero.
The serial connection was closed and released. This watched result confirms
smooth visible movement for this slow pattern; faster patterns, a live browser
event loop, and 115200 operation remain unverified. No baud commissioning
sequence was transmitted. Browser source was unchanged for this test, so the
206-test pass above is retained rather than rerun.


## October 13 continuation

The old tracker retained ordinary velocity but could chatter in acceleration or
invoke a rest-point fallback near a still-rising sine turn. This was reproduced
in host commands; native velocity reset at every FC7b target remains undocumented.
The current hardware planner carries PVA through future-state captures and
compatible intermediate points, using local Ruckig trajectories with finite
velocity, acceleration and jerk. Finite triangle, square and saw legs end with
zero velocity and acceleration at their actual reversals. Sine turns retain
nonzero acceleration. Intermediate USB samples preserve their moving PVA state.

The existing 1080 mm/s / 6000 mm/s² host limits, 20000 RPM/s servo ramp and
19200-baud comparison are retained. Host jerk is 100000 mm/s³, and references
reserve 95% of V/A/J for capture. The fixed-sine rate cap now includes jerk demand
`J = (2πf)³A`; triangle, square and saw use finite legs. The core loads a bundled
WASM asset before allowing motion, then computes synchronously offline. Full
source/build/license details are in [vendor/ruckig](../vendor/ruckig/README.md).

A recovered guard reply or uncertain target acknowledgment during a running
pattern now inhibits output and requires fresh stationary recapture. It never
replays a missed target or resumes across an unaccounted moving interval.

267/267 browser checks passed, including 13 core checks. Independent comparison
of 500 native C++/WASM trajectories agreed within 1.31e-13, and the binary rebuilt
to its pinned SHA-256. These are software checks, not physical acceptance.
USB timing, the approximately 20 Hz stream at 19200 baud, drive response and
modulated finite-path fidelity remain practical limits. The watched 1.5 Hz / 70%
sine was accepted as smooth with useful speed, and browser Home/Play/Stop passed;
see the current audit for the measured trials. General smoothness and
stock-firmware parity remain unverified.
