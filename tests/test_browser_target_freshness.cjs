// SPDX-License-Identifier: MPL-2.0
"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), vm = require("node:vm"), path = require("node:path");
const engineAPI = require("../virtual_synth/static/browser-engine.js");

async function delayedPlanner(cost, cancel = false) {
  await engineAPI.ready;
  let now = 0, targetActive = false, spent = false, runtime, sampled;
  const submitted = [];
  class CostEngine extends engineAPI.Engine {
    step(dt, controls) {
      const signal = super.step(dt, {...controls});
      if (targetActive && !spent) {
        spent = true; now += cost;
        if (cancel) runtime.stop();
      }
      return signal;
    }
    reset(options) { return super.reset({...options}); }
    configure(params) { return super.configure({...params}); }
  }
  const module = {exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,"../virtual_synth/static/browser-runtime.js"),"utf8"), {
    module, require: () => ({...engineAPI, Engine:CostEngine}),
    performance:{now:()=>now*1000}, structuredClone, queueMicrotask, clearTimeout, setTimeout,
  });
  const hw = {connected:true, homed:true, homing:false, owned:false, armed:false, running:false,
    stop_confirmed:true, position_normalized:.5, raw_bounds:[1000,148456],
    max_velocity_raw_s:1080*819.2,max_acceleration_raw_s2:6000*819.2,max_jerk_raw_s3:100000*819.2};
  const motor = {
    status:()=>({...hw}), connect:async()=>({...hw}),
    arm:async()=>{hw.armed=true;return {...hw};},
    start:async()=>{hw.owned=hw.running=true;return {...hw};},
    stop:async()=>{hw.owned=hw.armed=hw.running=false;hw.stop_confirmed=true;return {...hw};},
    async command(resolve) {
      targetActive=true;
      try { const target=resolve(); submitted.push({at:now,target}); return {...hw}; }
      finally {targetActive=false;}
    },
    recordPlannerSample(at,velocity,acceleration) {sampled={at,velocity,acceleration};},
    close:async()=>{},
  };
  const port = {}, serial = {getPorts:async()=>[port],requestPort:async()=>port};
  runtime=module.exports.createRuntime({clock:()=>now,serial,autoStart:false,storage:null,transportFactory:()=>motor});
  const action=(name,fields={})=>runtime.request("/api/action",{action:name,...fields});
  await action("connect",{port:await runtime.choosePort()});
  await action("configure",{params:{rate_hz:1.5,stroke:.7}}); await action("play");
  now=.05; await runtime.tick();
  const result={submitted,sampled,state:runtime.state()}; await runtime.close(); return result;
}

test("target is resampled across expensive capture calculation before its single native submission",async()=>{
  const result=await delayedPlanner(.006);
  const engine=new engineAPI.Engine({rate_hz:1.5,stroke:.7});
  engine.reset({position:.5,vmax:1080/180,amax:6000/180,jmax:100000/180});
  engine.step(.05,{running:true,tracking:true});
  const expected=engine.step(.006,{running:true,tracking:true});
  assert.equal(result.submitted.length,1);
  assert.ok(Math.abs(result.submitted[0].at-.056)<1e-12);
  assert.ok(Math.abs(result.submitted[0].target-expected.command)<1e-12);
  assert.equal(result.sampled.at,result.submitted[0].at);
  assert.equal(result.state.fault,null);
});

test("planner CPU cannot carry a target across the scheduling deadline or an immediate Stop",async()=>{
  const expired=await delayedPlanner(.251);
  assert.deepEqual(expired.submitted,[]); assert.equal(expired.state.running,false);
  assert.match(expired.state.fault,/scheduling deadline missed/);
  const cancelled=await delayedPlanner(.006,true);
  assert.deepEqual(cancelled.submitted,[]); assert.equal(cancelled.state.running,false);
  assert.equal(cancelled.state.fault,null);
});
