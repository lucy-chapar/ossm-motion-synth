# Serial throughput audit — October 13, 2026

This revision is local and not deployed. AJ's observation that communication
can approach 500 Hz prompted a separate audit of the serial path. The
continuous C2 planner is unchanged: host ceilings remain 1080 nominal mm/s,
6000 mm/s² and 100000 mm/s³. The current `servo_ramped` drive profile is
1800 RPM / 50000 RPM/s, nominally 33333 mm/s² at 40 mm/revolution. It replaces
20000 RPM/s after the guarded comparisons below.
Higher command throughput is not a higher mechanical frequency or motion limit.

## Removed scheduling limits

Previously, the browser requested targets every 50 ms at 19200/38400 baud and
every 20 ms at 115200. Each healthy exchange started a fresh 3 ms quiet wait,
even if the line had already been idle. At 19200, every target also incurred
one status-group transaction.

The runtime now sends a fresh target after the preceding transaction completes.
It has one exchange outstanding, yields to browser tasks, and never queues
missed positions. Ordinary traffic and transitions to/from FC7b require 2 ms
from the last received chunk; an already quiet line adds no new wait.
Consecutive clean FC7b transactions add no post-response delay. Startup/error
quarantine, CRC validation, cancellation immediately before writing, and
fail-closed active-run recovery remain in place.

The live trajectory is sampled at the final native-write boundary, after any
queue, guard-read and quiet-line waits. The connection replaces an unsent FC7b
placeholder with that fresh frame and validates its CRC, function and nonzero
target before writing. Stop and guard age are checked around the resolver.
A delayed task cannot send a reference calculated before the wait; a target
sample interval over 250 ms stops the run instead of catching up. Regression
tests cover a 75 ms placement delay and both sides of that deadline.

All supported baud rates reuse fresh guard values. After a full snapshot, the
four groups first become due at staggered 25 ms intervals. Each later receipt
schedules that group's next refresh 100 ms later. Normally one due group is
read; if any remaining group has 100 ms or less before the hard 250 ms age
limit, further due groups are drained. This separates the ordinary refresh due
time from the urgent-drain headroom and the unchanged write fence. All
configuration, alarm, output, rail and tracking checks remain. A stale guard
prevents the next write. Connect, Home, Arm and Stop retain full snapshots.

Scope history samples at roughly 50 Hz and keeps ten seconds independently of
serial completion and UI/state polling. `command_reply_count` counts completed
target replies; `command_reply_rate_hz` is a bounded one-second count/span
estimate, including intervening guard reads. Neither field measures carriage
velocity or pattern Hz.

## Baud commissioning and rollback

Register 24 decimal (`0x18`) is the standstill output/stall setting, not baud.
The [upstream enum and register map](https://github.com/ossm-rs/ossm-rs/blob/5f4edbd085da07e18f628b88cbad0caa96db269a/ossm-rs/src/motor/m57aimxx/mod.rs#L28-L94)
define `800=9600`, `801=19200`, `802=38400`, and `803=115200`.
Only 19200, 38400 and 115200 are supported by this browser.

At the current working baud, the verified slave-1 FC06 commissioning sequence is:

| Register | Value for 115200 | Frame including CRC |
|---|---:|---|
| 0 | 1 | `010600000001480a` |
| 3 | 803 | `01060003032338e3` |
| 4 | 129 | `010600040081086b` |
| 0 | 506 | `0106000001fa0819` |

The [upstream implementation](https://github.com/ossm-rs/ossm-rs/blob/5f4edbd085da07e18f628b88cbad0caa96db269a/ossm-rs/src/motor/m57aimxx/mod.rs#L307-L319)
uses addresses 3/4. The [vendor manual's baud paragraph, page 18](https://www.robotanno.com/web/userfiles/download/ACCESSORIES/IntegratedServoMotor/YZ-AIMManual_v2_55.pdf#page=18)
mislabels these as 2/3, contrary to its register map. No parameter-save command
is required. The final `506` is sent once; its acknowledgement may be missing
and does not prove the drive remains inhibited. The
[upstream caller](https://github.com/ossm-rs/ossm-rs/blob/5f4edbd085da07e18f628b88cbad0caa96db269a/ossm-rs/src/main.rs#L238-L251)
requires a motor power cycle before continuing.

Rollback uses the same sequence at the working baud, substituting `801` for
`803`, followed by another power cycle and CRC-valid 19200 readback. Back up
the current register snapshot first. Before the sequence and after its first
three writes, verify fresh inhibited, stationary feedback. Abort if that state
changes; never retry an ambiguous final commit. After restart, inspect output,
gearing and run settings rather than assuming they survived. Normal browser
Connect only probes status and does not commission baud.

On the connected drive, the sequence was applied once at 19200. All first-three
acknowledgements and inhibited/stationary readbacks passed. The final commit
was not treated as Stop proof. After the user's power cycle, fresh CRC-valid
115200 reads reported native mode 0, output status 7, and zero speed, pending
demand and alarm. A fresh Home then measured 179.691 nominal mm and passed.

## Measured link results and limits

The following tests each sent 100 FC7b commands with output inhibited and
verified stationary readbacks. They isolate the link and do not simulate an
active guarded waveform:

| Connection and I/O version | Completed replies/s |
|---|---:|
| 19200, earlier I/O | 62.227 |
| 115200, earlier I/O | 99.232 |
| 115200, after removing the fresh quiet wait | 177.746 |

Current 115200 transaction median was 5.536 ms, maximum 8.955 ms; the maximum
target gap was 8.940 ms. The before/after 115200 captures both held encoder
position at 20036 through three final readbacks with output disabled. Local
evidence is recorded in `ossm-link-115200-before-1791918209768.json` and
`ossm-link-115200-after-1791918219433.json` under `/private/tmp`; commissioning
is in `ossm-baud-115200-2026-10-13.json`. These captures are not export assets.

At 115200, an eight-byte request plus eight-byte reply uses 1.389 ms of wire
time at 8N1, leaving 0.611 ms in a hypothetical 2 ms cycle. At 19200 the same
exchange needs 8.333 ms before processing or adapter delays. Thus 500 Hz is
wire-feasible at 115200, but has not been achieved on this USB/browser path.
[Upstream FC7b](https://github.com/ossm-rs/ossm-rs/blob/5f4edbd085da07e18f628b88cbad0caa96db269a/ossm-rs/src/motor/m57aimxx/mod.rs#L274-L303)
adds no post-response delay; its 3 ms value is a response timeout.

## Guarded physical comparisons

The unsuccessful attempts are retained alongside the final trials:

| Attempt | Observed failure | Resulting change |
|---|---|---|
| Earlier capped 115200 / 1.5 Hz baseline | Guard age reached 253 ms; Stop confirmed | Phase refresh due times instead of bunching them |
| Completion-driven stream with 20000 RPM/s native ramp | Following-error guard fault | Test 50000 RPM/s with host V/A/J unchanged |
| Later stream with the earlier refresh timing | Guard age reached 264 ms | Refresh due at 100 ms and drain with 100 ms headroom |

The hard 250 ms guard fence and tracking limits were retained. With the final
guard scheduling and 50000 RPM/s native ramp, three separate six-second
physical runs passed at 115200. They used the production engine, runtime,
transport and I/O modules through an exclusive Node serial harness; the faster
native-ramp setting was initially a private override and is now the local
production default. This first series preceded the final native-write
resampling change described above.

| Requested pattern | Planned Hz | Targets (replies/s) | Command / encoder span, nominal mm | Sampled max absolute speed, mm/s | Maximum target gap, ms |
|---|---:|---:|---:|---:|---:|
| 1.5 Hz / 70% sine | 1.5 | 809 (134.833) | 98.390 / 97.117 | 438.667 | 35.900 |
| 2.5 Hz / 30% sine | 2.5 | 781 (130.167) | 42.166 / 40.771 | 344.133 | 19.650 |
| 2.5 Hz / 37.9% saw | 1.905 | 714 (119.000) | 53.271 / 52.872 | 497.600 | 20.710 |

The saw's planned rate was constrained by the unchanged host budgets. Velocity
figures are sampled register-16 maxima, not continuous physical peak speeds.
Each run ended with confirmed Stop and output, actual speed, PWM, pending
demand and alarm all zero. These guarded motion rates include status reads,
planner work and task scheduling, unlike the inhibited 177.746 replies/s link
benchmark. No test achieved 500 Hz.

After the final native-write sampling change, the exact final production
modules passed another fresh Home and three six-second trials:

| Requested pattern | Planned Hz | Targets (replies/s) | Command / encoder span, nominal mm | Sampled max absolute speed, mm/s | Maximum target gap, ms |
|---|---:|---:|---:|---:|---:|
| 1.5 Hz / 70% sine | 1.5 | 612 (102.000) | 98.395 / 96.914 | 475.200 | 53.562 |
| 2.5 Hz / 30% sine | 2.5 | 647 (107.833) | 42.168 / 40.511 | 402.200 | 22.453 |
| 2.5 Hz / 37.9% saw | 1.905 | 644 (107.333) | 53.273 / 52.878 | 461.067 | 30.585 |

Every run confirmed Stop with zero output, speed, PWM, pending demand and
alarm. Maximum reported guard ages were 111–114 ms. The lower rates in this
series record observed path variation; the trials do not isolate its cause.
Source hashes and both trace summaries are retained in the
[QA record](qa/2026-10-13-serial-throughput.json).

A separate earlier slow sine passed and confirmed Stop, then the serial link
failed while idle. Fresh inhibited readback was verified before continuing.
The user reported a coincident WiFi interruption; causality was not established.
A later strict stationary benchmark retry rejected its read-only precondition
before transmitting any target, so it adds no throughput result.

The final exported assets were loaded in Chrome on the same localhost origin.
A fresh browser Home completed at approximately 179.7 nominal mm. The normal
Play control ran a short 2.5 Hz / 37.9% saw; the UI showed 80 command updates/s
while running and retained 85/s at Stop. These are rounded one-second
count/span displays, not an average of the whole run. Stop showed Confirmed,
and the app was left connected, homed and stopped with those controls restored.
The [screenshot](images/serial-throughput-2026-10-13.jpg) records this final state.

All 290 browser tests and 132 Python tests pass. Fourteen exported files matched
their served SHA256 values and the WASM MIME was application/wasm. The earlier
watched C2 acceptance applies to its recorded 19200-baud / 20000 RPM/s version;
see the [historical planner audit](MOTION_PLANNER_AUDIT.md). These trials do not
establish general smoothness across loads or parity with stock firmware.

Offline timing models can vary adapter overhead, bounded jitter and run length:

```sh
node scripts/benchmark_streaming.cjs --baud 115200 --adapter-ms 0 --jitter-ms 0 --targets 1000
node scripts/benchmark_streaming.cjs --baud 115200 --adapter-ms 10 --jitter-ms 2 --targets 1000
node scripts/benchmark_streaming.cjs --baud 19200 --adapter-ms 10 --jitter-ms 2 --targets 1000
```

These models check one outstanding exchange and guard ages, with instantaneous
synthetic following. They do not model browser timer jitter, USB scheduling or
servo dynamics and are not physical throughput or smoothness evidence.
