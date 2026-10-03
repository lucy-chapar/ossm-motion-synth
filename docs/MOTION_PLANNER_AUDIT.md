# Motion planner audit — 2026-10-03

The slow-sine test established visible smoothness at 0.25 Hz / 30% stroke.
It did not establish useful speed or smoothness under demanding curves. That
test required only about 33.5 mm/s and 52.6 mm/s². The user's subsequent report
of slow movement and jitter on curves is the reason for this audit.

This revision is local. Its new behavior has offline verification; fast physical
motion, the browser event loop with a connected motor, and 115200 operation
still need matched physical tests.

## Where performance was lost

| Stage | Finding | Effect |
| --- | --- | --- |
| Geometry | Stroke multiplies the room on both sides of Center | Off-center motion can be much shorter than the Stroke knob suggests |
| Host acceleration | The ramped default limited acceleration to 1200 mm/s² | Many ordinary curves were infeasible despite ample velocity headroom |
| Drive acceleration | Register 3 was also set to 2000 RPM/s, about 1333 mm/s² | A second trajectory ramp added lag to already planned targets |
| Phase | Requested phase kept advancing while the pursuit planner saturated | Planned stroke collapsed instead of preserving travel at a feasible rate |
| Endpoint pursuit | Square endpoints used velocity = feed + 6 × position error | Approach was gradual and left available velocity unused |
| Corners/flyback | Triangle corners and saw resets had no finite transition time | Triangle overshoot and large saw attenuation |
| Serial | At 19200 baud, observed complete cycles reached 51.89 ms | About 20 target updates/s; 2 ms host substeps do not reach the drive |

The hardware Arm path replaces the preview's normalized velocity and
acceleration limits with the transport's physical budgets divided by the
measured span. Run preserves them. There is no additional legacy preview
velocity cap in hardware. The 90% velocity reserve is applied once: drive
speed ceiling 1800 RPM is 1200 nominal mm/s; host ceiling is 1080 mm/s.

## Geometry and first-principles demand

The assumed conversion is 32768 encoder counts/revolution and 40 mm/revolution,
or 819.2 counts/mm. The watched Home measured about 181.57 nominal mm between
contacts. Subtracting the existing 1638-count inset at each end leaves
177.571 mm. The default 10–90% command window spans 142.057 mm.

For that window W, stroke fraction s, and center fraction c:

`A = s × W × min(c, 1-c)`; full displacement `D = 2A`.

70% Stroke at 50% Center requests 99.44 mm. The earlier 62% Stroke / 8% Center
setting requests 14.09 mm; at 50% Center it requests 88.08 mm. This geometry is
preserved, and the UI now shows the resulting distance and explains contraction.

For a fixed sine:

`peak velocity = π f D`

`peak acceleration = 2 π² f² D`

`maximum feasible f = min(V / (π D), sqrt(a / (2 π² D)))`

| Sine request | Full displacement | Peak velocity | Peak acceleration |
| --- | ---: | ---: | ---: |
| 0.25 Hz / 30% | 42.62 mm | 33.47 mm/s | 52.58 mm/s² |
| 0.5 Hz / 70% | 99.44 mm | 156.20 mm/s | 490.72 mm/s² |
| 1.5 Hz / 70% | 99.44 mm | 468.60 mm/s | 4416.44 mm/s² |
| 2.5 Hz / 30% | 42.62 mm | 334.71 mm/s | 5257.67 mm/s² |

The last two requests fit the existing 6000 mm/s² streaming budget but exceed
the 1200 mm/s² ramped budget. Velocity was not the binding limit.

## Comparison with motor-local firmware

The current [stock OSSM configuration](https://github.com/KinkyMakers/OSSM-hardware/blob/main/Software/src/constants/Config.h)
sets 1500 RPM, 40 mm/revolution, 800 pulse steps/revolution, and 50000 mm/s².
That is a 1000 mm/s speed ceiling and 20000 step pulses/s at maximum speed.
Its [streaming task](https://github.com/KinkyMakers/OSSM-hardware/blob/main/Software/src/ossm/streaming/streaming.cpp)
passes motion parameters to [FastAccelStepper](https://github.com/gin66/FastAccelStepper),
which generates pulses continuously with hardware timing. Application polling
frequency and pulse timing are different jobs.

The current browser's 1200 mm/s² ramped ceiling was only 2.4% of that configured
stock acceleration. Rest-to-rest travel over 100 mm needs at least 0.577 s at
1200 mm/s². Stock's 1000 mm/s and 50000 mm/s² allow a theoretical 0.120 s.
These are configured mathematical budgets, not measurements of this machine.
The restored 1080/6000 browser budget still takes about 0.258 s; restoring it
does not establish parity with stock's maximum response.

As a separate RS485 reference, [OSSM-RS configuration](https://github.com/ossm-rs/ossm-rs/blob/main/ossm-motion/src/config.rs)
uses a 10 ms motion loop, 600 mm/s, 30000 mm/s² and 100000 mm/s³. Its
[motion control](https://github.com/ossm-rs/ossm-rs/blob/main/ossm-motion/src/motion_control/mod.rs)
retains Ruckig position, velocity and acceleration across updates. Its motor
driver uses 115200 baud and a much higher internal acceleration setting
(50000 RPM/s), so the presence of a second drive limit alone does not prove
poor motion; the relative budget and update architecture matter. The exact
project meant by "OSSM All" has not been identified, so this is an explicitly
named comparison, not an assumed identification.

## Revised trajectory ownership

The browser now selects the existing `streaming` profile. The host owns velocity
and acceleration shaping; register 3 is 60098 to bypass the drive's internal
acceleration ramp with 98% position feedforward. This value is an encoded mode,
not 60098 RPM/s. The [vendor manual, physical page 11](https://www.robotanno.com/web/userfiles/download/ACCESSORIES/IntegratedServoMotor/YZ-AIMManual_v2_55.pdf)
describes its meaning. Profile budgets are now written in explicit mm/s².
Telemetry reports this encoded setting as `acceleration_setting_raw`, names the
feedforward mode and percentage, and reports `acceleration_rpm_s` only for an
actual ramp setting. An encoded feedforward value is no longer labeled RPM/s.
The established 1080 mm/s / 6000 mm/s² ceilings are retained for the initial
physical comparison, rather than assuming stock's higher setting has been
validated on this serial path.

These limits bound the host's continuous mathematical trajectory. They do not
establish a physical encoder acceleration ceiling between discrete FC7b targets
when the servo ramp is bypassed. Fresh telemetry and the existing fault/Stop
checks remain independent; physical response requires encoder measurements.

```mermaid
flowchart LR
    P[Parameters and modulation] --> G[Bounded stroke geometry]
    G --> R[Feasible phase and finite transitions]
    R --> T[Host trajectory: position and velocity]
    T --> S[Current FC7b position target]
    S --> M[Servo closed position loop]
```

Requested phase remains available for the scope. A separate planned phase
retimes an infeasible fixed sine to preserve its full stroke. For a rest-to-rest
move of distance D:

`T = 2 sqrt(D/a)` when `D <= V²/a`; otherwise `T = D/V + V/a`.

Square half-cycles allow at least T and use the exact point planner. Triangle
half-cycles use finite trapezoidal transitions over their available duration.
Saw allocates T to a bounded flyback and the rest of its cycle to the forward
stroke. Their rate cap allows at least 2T per cycle. Sharp ideal corners are
therefore explicitly changed into physical transitions, rather than treated
as attainable reference motion.

Triangle/saw references reserve 10% of the host velocity/acceleration budget
for capture after startup and parameter changes. A minimum-time reference
using 100% of acceleration left persistent phase error because the tracker had
no budget to catch up. The reserve changes reference planning, not the hard
output ceiling or an additional servo ramp. Square uses one exact point planner;
fixed sines use the analytic frequency limit without this corner-capture reserve.

The continuous tracker also brakes against the intended stroke endpoints when
the current position and stopping point fit that stroke. During an abrupt
center or stroke change it retains the wider rail bounds until that stopping
distance fits; it never erases existing velocity. This removes steady overshoot
without pretending a changing window can stop motion instantly.

Position patches retain bounded tracking. Full stroke/phase fidelity claims
apply to fixed waves. Modulated center, amplitude and rate have additional
derivatives; the trajectory's velocity, acceleration and stopping guards still
apply, but the fixed-wave capacity formula alone does not establish fidelity.
This planner does not yet impose a jerk limit. Adding one requires budgeting
its stopping distance, not applying another arbitrary smoothing filter.

Pause retains the planned phase, including when it differs from requested phase.
Resume seeds the trajectory from fresh stationary motor feedback. Stop intent,
fresh status, tracking checks and inhibited stationary Stop confirmation remain.

## Serial constraints and update changes

[FC7b](https://github.com/ossm-rs/ossm-rs/blob/main/ossm-rs/src/motor/m57aimxx/mod.rs#L255-L282)
contains only an absolute position. It carries no arrival time or velocity and
has no documented queued interpolation contract. The manual's 2 kHz internal
position sampling does not mean a 20 Hz RS485 command stream is interpolated
into the requested curve. Mechanical position need not jump, but smooth fast
tracking of discrete setpoints is not guaranteed.

At 19200/38400 the 50 ms schedule and one rotating guard read per target remain.
At a successfully discovered 115200 connection, the requested deadline is now
20 ms. Fresh guards can be reused; the oldest group is refreshed at 150 ms,
with the same strict 250 ms fence before native target transmission. Connect
still probes read-only and never changes the motor's baud. Home, Arm, Stop
and recovery still use full snapshots. No missed-target queue is built.

With the same modeled USB overhead, the faster-baud scheduler improves delivered
throughput from 33.62 to 38.93 targets/s. This is not uniform 50 Hz: modeled
maximum spacing grows from 29.73 to 35.34 ms while some shorter intervals become
possible. This tradeoff must be measured against encoder motion, not presented
as proven smoothness. Hardware-timed interpolation or a motor-local motion
controller remains the stronger architecture for matching firmware timing.

## Reproduction and physical acceptance

```sh
node scripts/benchmark_motion_capacity.cjs --table
node scripts/benchmark_streaming.cjs --baud 19200
node scripts/benchmark_streaming.cjs --baud 115200
node --test --test-concurrency=1 tests/*.cjs
python3 scripts/export_web.py
```

The capacity benchmark loads the exact prior engine at
`dfc0b3781dafce221a8ecccac530227a559ee336`, uses a nominal measured span, and
compares fixed 50 ms and irregular 20–75 ms calls. It does not model the servo,
browser event loop, force, or USB timer jitter. Planned-reference RMS for finite
curves is distinct from error against the impossible sharp requested waveform.

On the irregular schedule, after excluding three seconds of startup:

| Pattern | Prior ramped host span | Revised streaming host span | Revised planned-reference RMS |
| --- | ---: | ---: | ---: |
| Sine 1.5 Hz / 70% | 35.57 mm | 99.43 mm | 0.184 mm |
| Sine 2.5 Hz / 30% | 13.35 mm | 42.61 mm | 0.158 mm |
| Square 1.5 Hz / 70% | 84.30 mm | 99.44 mm | Endpoint arrival, not jump RMS |
| Triangle 1.5 Hz / 70% | 68.35 mm | 99.44 mm | 0.170 mm |
| Saw 1.5 Hz / 70% | 29.61 mm | 99.44 mm | 0.196 mm |

The square's reference is an endpoint target; error during finite transit is
expected. Its acceptance is arrival at both endpoints within the half-cycle,
without violating velocity, acceleration, stroke or stopping limits.

The final local revision passes all 239 browser tests, including production
runtime/profile wiring, planned-phase Pause/Resume, stop and telemetry guards,
finite curve transitions, and tiny-stroke numeric regressions. The web export
was rebuilt and every exported asset matched its source-manifest SHA-256.
These checks verify the software and packaged assets; Python tests were not
rerun because this revision changes only the browser path.

Physical acceptance should compare the same measured rail, centered stroke,
rate and load; capture encoder span, full target intervals and cycle durations,
following error, fresh status ages, and confirmed final inhibition. Start with
one watched bounded pattern and increase only after that observation. Higher
acceleration and persistent baud commissioning remain separate physical steps.
The earlier smooth 0.25 Hz result must not be used as evidence for fast motion.
