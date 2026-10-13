// SPDX-License-Identifier: MPL-2.0
// Real planner and controlled mock acceptance only; no browser or device.
"use strict";
const assert = require("node:assert/strict"), test = require("node:test");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const {Engine} = require("../virtual_synth/static/browser-engine.js");
const {createRuntime} = require("../virtual_synth/static/browser-runtime.js");
const countsPerMm = 819.2, span = 175.69580078125 * countsPerMm;

async function hardware(params = {}, rawSpan = span) {
  let now = 0, runtime;
  const sent = [];
  const hw = {connected:true, homed:true, homing:false, owned:false, armed:false, running:false,
    stop_confirmed:true, position_normalized:.5, raw_bounds:[1000, 1000 + rawSpan],
    max_velocity_raw_s:1080*countsPerMm, max_acceleration_raw_s2:6000*countsPerMm,
    max_jerk_raw_s3:100000*countsPerMm, nominal_counts_per_mm:countsPerMm, communication_recoveries:0};
  const motor = {
    omitResolver:false, beforeResolve:null,
    status:()=>({...hw}), connect:async()=>({...hw}), snapshot:async()=>({...hw}),
    motionDiagnostics:()=>({rows:[]}),
    arm:async()=>{hw.armed=true;return {...hw};},
    start:async()=>{hw.owned=hw.running=true;hw.stop_confirmed=false;return {...hw};},
    stop:async()=>{hw.owned=hw.armed=hw.running=false;hw.stop_confirmed=true;return {...hw};},
    async command(resolve) {
      if (this.omitResolver) return {...hw};
      this.beforeResolve?.();
      let target;
      try { target = resolve(); } catch (error) { this.lastResolverError = error; throw error; }
      sent.push({at:now, target}); hw.position_normalized=target;
      return {...hw};
    },
    close:async()=>{},
  };
  const port = {}, serial = {getPorts:async()=>[port],requestPort:async()=>port};
  runtime=createRuntime({clock:()=>now,serial,autoStart:false,storage:null,transportFactory:()=>motor});
  const action=(name,fields={})=>runtime.request("/api/action",{action:name,...fields});
  await action("connect",{port:await runtime.choosePort()});
  await action("configure",{params:{rate_hz:1.4985372650797282,stroke:.5,...params}});
  await action("play");
  const tick=async dt=>{now+=dt;await action("heartbeat");await runtime.tick();return runtime.state();};
  const atPhase=async phase=>{
    for (let index=0;index<1800;index++) {
      const state=await tick(.005);
      assert.equal(state.fault,null);
      if (now>2 && state.signal.reference_phase>=phase && state.signal.reference_phase<phase+.02) return state;
    }
    assert.fail(`never reached steady phase ${phase}`);
  };
  return {runtime,motor,hw,sent,action,tick,atPhase,advance:dt=>{now+=dt;},time:()=>now};
}

test("209 ms scheduling stall stops before its 58 mm catch-up target", async () => {
  const env=await hardware();
  try {
    await env.atPhase(.335);
    const count=env.sent.length, previous=env.sent.at(-1).target;
    const state=await env.tick(.2091);
    assert.equal(env.sent.length,count,"no post-stall target reaches native submission");
    assert.equal(env.hw.position_normalized,previous);
    assert.equal(state.running,false); assert.equal(state.hardware.stop_confirmed,true);
    assert.match(state.fault,/Motion continuity lost.*No catch-up target was sent/);
    assert.equal(env.motor.lastResolverError.code,"MOTION_CONTINUITY_GAP");
  } finally {await env.runtime.close();}
});

test("rejected continuity-gap diagnostics preserve the pending PVA and exact units through Reset until a new Run",async()=>{
  const env=await hardware();
  try {
    await env.atPhase(.335);const acceptedAt=env.sent.at(-1).at,count=env.sent.length;
    await env.tick(.2091);
    const saved=await env.runtime.request("/api/motion-diagnostics"),gap=saved.last_continuity_gap;
    assert.equal(env.sent.length,count,"recording rejected-state diagnostics cannot submit the catch-up point");
    assert.equal(gap.elapsed_run_s,env.time()-saved.run_started_at_s);
    assert.equal(gap.last_target_sampled_at_s,acceptedAt);
    assert.ok(Math.abs(gap.elapsed_since_last_target_sample_s-.2091)<1e-9);
    assert.ok(gap.unsent_travel_normalized>gap.budget_normalized);
    assert.equal(gap.unsent_travel_raw,gap.unsent_travel_normalized*span);
    assert.equal(gap.unsent_travel_mm,gap.unsent_travel_raw/countsPerMm);
    assert.equal(gap.budget_raw,gap.budget_normalized*span);
    assert.equal(gap.budget_mm,gap.budget_raw/countsPerMm);
    assert.ok(Object.values(gap.pending_engine_pva).every(Number.isFinite));
    assert.notEqual(gap.pending_engine_pva.velocity,0,"fault capture precedes the stationary Stop reset");
    gap.pending_engine_pva.velocity=999;
    await env.action("reset");
    const retained=(await env.runtime.request("/api/motion-diagnostics")).last_continuity_gap;
    assert.notEqual(retained.pending_engine_pva.velocity,999,"export is detached");
    assert.equal(retained.unsent_travel_raw,gap.unsent_travel_raw,"Reset preserves the failed-run evidence");
    await env.action("play");await env.action("stop");
    assert.equal((await env.runtime.request("/api/motion-diagnostics")).last_continuity_gap,null);
  } finally {await env.runtime.close();}
});

test("49 ms near a reversal retains useful movement without an arbitrary time cap", async () => {
  const env=await hardware();
  try {
    await env.atPhase(.26);
    const count=env.sent.length, previous=env.sent.at(-1).target;
    const state=await env.tick(.0492);
    assert.equal(state.fault,null); assert.equal(state.running,true); assert.equal(env.sent.length,count+1);
    const movementMm=Math.abs(env.sent.at(-1).target-previous)*span/countsPerMm;
    assert.ok(movementMm>1 && movementMm<10,"a geometrically small late update remains useful");
  } finally {await env.runtime.close();}
});

test("a skipped full period stops even when its final position returns to the same endpoint", async () => {
  const env=await hardware({rate_hz:4,stroke:.08});
  try {
    const before=await env.atPhase(.49);
    assert.equal(before.signal.rate_limited,false);
    const count=env.sent.length;
    const expected = .5 + .032 * Math.sin(2*Math.PI*(before.signal.reference_phase + 4*.249999999));
    assert.ok(Math.abs(expected-env.sent.at(-1).target)<1e-8,"the proposed endpoint displacement would hide the skipped excursion");
    const after=await env.tick(.249999999);
    assert.equal(env.sent.length,count); assert.equal(after.hardware.stop_confirmed,true);
    assert.match(after.fault,/Motion continuity lost/);
  } finally {await env.runtime.close();}
});

test("the travel bound includes unsent reversals while preserving exact ordinary PVA and rate", async () => {
  const engine=new Engine({rate_hz:4,stroke:.08});
  engine.reset({position:.5,vmax:1080/(span/countsPerMm),amax:6000/(span/countsPerMm),jmax:100000/(span/countsPerMm)});
  for (let i=0;i<1000;i++) engine.step(.002,{running:true,tracking:true});
  const previous=engine.trajectory.position, anchor=engine.commandedTravelUpper();
  engine.step(.25,{running:true,tracking:true});
  assert.ok(Math.abs(engine.trajectory.position-previous)<1e-10);
  assert.ok(engine.commandedTravelUpper()-anchor >= .128-1e-8,"path bound covers the complete excursion, not its zero chord");
  const env=await hardware({rate_hz:1.5,stroke:.7});
  try {
    await env.atPhase(.49);
    for (let i=0;i<200;i++) {
      const state=await env.tick(.005), signal=state.signal;
      assert.equal(state.fault,null); assert.equal(signal.planned_rate_hz,1.5); assert.equal(signal.rate_limited,false);
      assert.ok(Math.abs(signal.command-signal.planned_reference)<1e-10);
      assert.ok(Math.abs(signal.velocity-signal.planned_reference_velocity)<1e-10);
      assert.ok(Math.abs(signal.acceleration-signal.planned_reference_acceleration)<1e-10);
    }
  } finally {await env.runtime.close();}
});

test("read-only completion and scope polling cannot acknowledge unsent motion", async () => {
  const env=await hardware();
  try {
    await env.atPhase(.49);
    const count=env.sent.length;
    env.motor.omitResolver=true;
    await env.tick(.03); await env.tick(.03);
    for (let i=0;i<20;i++) await env.runtime.request("/api/state");
    env.motor.omitResolver=false;
    const state=await env.tick(.005);
    assert.equal(env.sent.length,count);
    assert.match(state.fault,/Motion continuity lost/);
    assert.equal(state.hardware.stop_confirmed,true);
  } finally {await env.runtime.close();}
});

test("raw velocity allowance and measured range are normalized exactly once", async () => {
  const env=await hardware({},1000000);
  try {
    const before=await env.atPhase(.49);
    const budget=Math.min(100000,.1*env.hw.max_velocity_raw_s+1024)/1000000;
    assert.ok(budget<.09,"raw velocity allowance, rather than a second normalized limit, controls this large range");
    const count=env.sent.length;
    const nominalAdvance = Math.abs(before.signal.velocity)*.115;
    assert.ok(nominalAdvance>.09 && nominalAdvance<.1);
    const state=await env.tick(.115);
    assert.equal(env.sent.length,count); assert.match(state.fault,/Motion continuity lost/);
  } finally {await env.runtime.close();}
});

test("Stop during final resolution fences the target and a new Play starts a fresh observation interval", async () => {
  const env=await hardware();
  try {
    await env.atPhase(.49);
    const count=env.sent.length;
    env.motor.beforeResolve=()=>env.runtime.stop();
    const stopped=await env.tick(.005);
    assert.equal(env.sent.length,count); assert.equal(stopped.running,false); assert.equal(stopped.hardware.stop_confirmed,true);
    env.motor.beforeResolve=null;
    await env.action("play");
    const resumed=await env.tick(.005);
    assert.equal(resumed.fault,null); assert.equal(resumed.running,true); assert.equal(env.sent.length,count+1);
  } finally {await env.runtime.close();}
});

test("worker-owned runtime exposes its factory without opening a second controller", async () => {
  const source=fs.readFileSync(path.join(__dirname,"../virtual_synth/static/browser-runtime.js"),"utf8");
  for (const fields of [{MotionWorkerOwner:true}, {MotionBrowserRuntime:{proxy:true}}]) {
    const context={...fields, MotionBrowserEngine:{Engine:class {constructor(){assert.fail("must not instantiate beside the worker owner/proxy");}}}};
    vm.runInNewContext(source,context);
    assert.equal(typeof context.MotionBrowserRuntimeAPI.createRuntime,"function");
    if (fields.MotionBrowserRuntime) assert.equal(context.MotionBrowserRuntime,fields.MotionBrowserRuntime);
    else assert.equal(context.MotionBrowserRuntime,undefined);
  }
});

test("worker serial support uses granted ports while chooser stays in the main window", async () => {
  const info={usbVendorId:0x1a86,usbProductId:0x7523}, port={getInfo:()=>info};
  const runtime=createRuntime({serial:{getPorts:async()=>[port]},autoStart:false,storage:null});
  try {
    assert.equal(runtime.state().web_serial_supported,true);
    const result=await runtime.request("/api/ports");
    assert.equal(result.ports.length,1); assert.deepEqual(JSON.parse(result.ports[0].identity),info);
    await assert.rejects(runtime.choosePort(),/main browser window/);
  } finally {await runtime.close();}
});
