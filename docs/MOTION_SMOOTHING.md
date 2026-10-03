# Browser motion smoothing — 2026-10-02

Local development against `0ad919ebf362c7a617ffeb46c92cbaffa42aa5dd`.
This revision has not been deployed or tested on a connected motor.

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
- Fresh fast-position feedback is compared with the current transmitted target.
  Comparing with the previous target could falsely fault a correctly following
  fast stroke at the new steady cadence. The tracking tolerance and three-sample
  fault rule are unchanged. The vendor does not specify the encoder capture time,
  so this alignment still requires physical validation.

Drive mode, baud, velocity/acceleration ceilings, calibrated travel guards and
stationary Stop verification are retained. This does not add a jerk limit or
establish the drive's interpolation behavior between targets.

## Offline results

183 browser tests and all 132 Python tests pass. Python server tests required
loopback socket access. The standalone browser export and its asset hashes were
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
node --test tests/*.cjs
python3 -m unittest discover -s tests
node scripts/benchmark_tracking.cjs --baseline 0ad919e
node scripts/benchmark_streaming.cjs
python3 scripts/export_web.py --output dist/web
```

## Connected validation still required

Compare the old and new revisions with the same adapter, motor, rail and settings.
Begin with a supervised ten-second slow sine and confirm Stop. Then test the
1.5 Hz / 70% and 2.5 Hz / 30% patterns in separate ten-second runs, including
Pause/Resume and confirmed final inhibition. Record actual command intervals,
encoder span and lag, overshoot, status ages and any communication recovery.
Judge motion from the physical run and encoder trace; the offline curves alone
cannot sign off smoothness. Retain the current live release until that check.
