# Local Ruckig motion core

This directory pins **Ruckig Community 0.15.3**, upstream commit
`37b6e7a4c60f5befd2506741d5f7d0ae7eefb3db`:
[official source](https://github.com/pantor/ruckig/tree/37b6e7a4c60f5befd2506741d5f7d0ae7eefb3db).
`upstream/` contains unmodified headers, the eleven local calculation sources,
and the MIT license. Cloud-client code, Python bindings, and their dependencies
are excluded from the build. `provenance.json` records every source hash, the
binding hash, compiler, flags, toolchain digest, and resulting WASM digest.

`bindings.cpp` supplies a fixed one-dimensional C ABI. The compiled artifact is
`virtual_synth/static/ruckig-core.wasm`; `ruckig-core.js` is the browser/CommonJS
adapter. They require no CDN, cloud calculation, native application, or firmware
change at runtime. The module's only imports are a monotonic clock and three
file-descriptor functions that the adapter returns `EBADF` for; it has no host
filesystem, network, or serial access. Initial linear memory is 512 KiB, maximum
16 MiB, with a 256 KiB stack.

## Reproduce the binary

Use Python 3.11 or later from the repository directory:

```sh
python3 scripts/build_ruckig.py --download-toolchain
```

This downloads the official, SHA-verified **WASI SDK 34** into the operating
system's temporary directory. Nothing is installed globally. Alternatively,
point to an already extracted SDK:

```sh
python3 scripts/build_ruckig.py --sdk /path/to/wasi-sdk-34.0-arm64-macos
```

The build uses the SDK's `23.1.0-wasi-sdk` compiler, C++17, `-O3`, and no fast-math,
exceptions, RTTI, or cloud-client definition. A normal rebuild must reproduce
the recorded binary SHA-256 and refuses changed upstream files. An intentional
reviewed binding change can be recorded with `--update-provenance`; that also
updates the local browser WASM cache key. It never changes upstream hashes.

```sh
node --test tests/test_ruckig_core.cjs
```

## JavaScript interface

CommonJS loads the adjacent WASM synchronously:

```js
const MotionRuckig = require("./virtual_synth/static/ruckig-core.js");
const planner = new MotionRuckig.Planner({ cycleTime: 0.002 });
const constraints = { vmax: 30, amax: 20, jmax: 100, minimumDuration: 0 };
const trajectory = planner.calculate(
  { position: 0, velocity: 10, acceleration: 2 },
  { position: 20, velocity: 15, acceleration: -1 },
  constraints,
);
const next = trajectory.sample(0.002);
const stop = planner.brake(next, constraints);
// stop.minPosition and stop.maxPosition describe the entire stopping path.
planner.dispose();
```

In a browser, load `ruckig-core.js` and await `MotionRuckig.ready` before creating
a planner. That promise fetches only the sibling local WASM asset. All subsequent
calculation and sampling calls are synchronous. A load failure rejects the
promise; callers must handle it before allowing motion.

State-to-state `calculate(current, target, constraints)` takes **explicit finite
position, velocity, and acceleration** for both states. Limits are positive and
finite; `minimumDuration` is an optional nonnegative lower bound, not a promised
exact duration. No terminal derivative is silently replaced with zero.

The returned trajectory has `duration`, `minPosition`, `maxPosition`,
`minPositionTime`, and `maxPositionTime`. `sample(t)` returns position, velocity,
acceleration, and jerk for `0 <= t <= duration`. Jerk is piecewise constant;
position, velocity, and acceleration are continuous. Invalid inputs or solver
errors throw rather than returning a clamped substitute.

`calculateVelocity(current, {velocity, acceleration}, constraints)` uses the
velocity-control interface. `brake(current, constraints)` specializes it to
terminal velocity and acceleration of zero. These use a **separate trajectory
handle**, so stopping-path inspection does not overwrite the active position
trajectory. Extrema include all transient overshoot and the actual absolute
origin, including a stationary trajectory of zero duration.

Each planner reuses its position and velocity handles in place. Retain a path
across recalculation with `trajectory.snapshot()`; dispose that independent
snapshot when finished. Dispose the planner to release its owned trajectories.
FinalizationRegistry provides backup cleanup where available.

For online generation, `reset(current)` sets the initial PVA state, then
`update(target, constraints)` advances by `cycleTime` and calls upstream
`output.pass_to_input` to preserve all three state derivatives on retargeting.
This API mirrors upstream behavior after `Finished`; a nonzero terminal velocity
continues moving if the caller keeps updating without a new target.

## Wrapper corrections

The ABI uses Time synchronization so a single-DoF path honors `minimumDuration`.
With None synchronization, an independently completed profile may otherwise be
extrapolated to the requested duration using its nonzero terminal derivatives.

Ruckig 0.15.3's convenience position-extrema helper omits velocity roots inside
zero-jerk constant-acceleration segments and considers the unset `pf` field in
velocity-control profiles. The wrapper computes extrema analytically over the
exposed two brake segments and seven main constant-jerk segments, evaluating
every real root of `v(t) = v0 + a0*t + j*t*t/2` and each segment endpoint. It uses
actual trajectory start/end samples and never a sampled approximation or a
modified motion profile. Regression tests cover these cases.

The core plans trajectories; hardware bounds, feedback freshness, scheduling,
faults, and Stop ownership remain the responsibility of the controller.

## Licenses

Ruckig is MIT licensed, copyright 2021 Lars Berscheid; see `upstream/LICENSE`.
Our binding, adapter, build script, and tests are MPL-2.0. The WASM also includes
WASI libc/libc++ runtime portions. Their upstream license notices are bundled
with Ruckig's license in `virtual_synth/static/ruckig-LICENSE.txt`, including the
Apache-2.0 LLVM exceptions, MIT, BSD notices, and public-domain allocator notice.
Pinned runtime license sources are recorded in `provenance.json`.
