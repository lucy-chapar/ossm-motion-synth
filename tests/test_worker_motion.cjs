// SPDX-License-Identifier: MPL-2.0
"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),path=require("node:path");
const {Worker}=require("node:worker_threads");
const {createClient}=require("../virtual_synth/static/worker-client.js");
const info={usbVendorId:0x1a86,usbProductId:0x7523};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function owner(options={}) {
  let worker,terminated=0;
  const storageValues=new Map(),messages=[];
  const client=createClient({serial:{requestPort:async()=>({getInfo:()=>info,open:()=>{throw new Error("Window must never open serial")}})},
    storage:{getItem:key=>storageValues.get(key),setItem:(key,value)=>storageValues.set(key,value)},
    workerFactory:()=>{
      worker=new Worker(path.join(__dirname,"fixtures/worker_owner_node.cjs"),{workerData:options});
      return {postMessage:message=>{messages.push(message);worker.postMessage(message);},
        addEventListener(name,listener){worker.on(name,name==="message" ? data=>listener({data}) : listener);},
        terminate(){terminated++;worker.terminate();}};
    }});
  return {client,storageValues,messages,terminated:()=>terminated,
    // Test cleanup only, after the same stopped/closed proof as the client.
    async shutdown(){await client.close();},worker:()=>worker};
}
async function connect(env) {
  await env.client.ready;
  const id=await env.client.choosePort();
  return env.client.request("/api/action",{action:"connect",port:id});
}
async function waitForInitialMotion(env) {
  let expiry,finished=false;
  const observing=(async()=>{
    while(!finished) {
      const state=await env.client.request("/api/state");
      assert.equal(state.fault,null);assert.equal(state.running,true);
      if(state.hardware.command_count>0)return;
      await env.client.request("/api/action",{action:"heartbeat"});await sleep(10);
    }
  })();
  try {await Promise.race([observing,new Promise((_,reject)=>{
    expiry=setTimeout(()=>reject(new Error("Worker did not submit initial motion within two seconds")),2000);
  })]);}
  finally {finished=true;clearTimeout(expiry);}
}
test("worker owns motion despite a blocked Window thread and closes only after confirmed Stop",async()=>{
  const env=owner();
  try {
    await connect(env);
    await env.client.request("/api/action",{action:"configure",params:{rate_hz:.25,stroke:.1}});
    await env.client.request("/api/action",{action:"play"});
    await waitForInitialMotion(env);
    const sentBeforeBlock=env.messages.length,blockedAt=performance.timeOrigin+performance.now();
    while(performance.timeOrigin+performance.now()-blockedAt<120) {} // Deliberate Window/DOM-like synchronous stall.
    const unblockedAt=performance.timeOrigin+performance.now();
    assert.equal(env.messages.length,sentBeforeBlock,"the Window sends no RPC or per-target IPC while blocked");
    const stopped=await env.client.stop();
    assert.equal(stopped.hardware.stop_confirmed,true); assert.equal(stopped.running,false);
    const trace=await env.client.request("/api/motion-diagnostics");
    assert.equal(trace.execution_context,"dedicated_worker");
    const duringBlock=trace.motion.command_times_ms.filter(at=>at>blockedAt&&at<unblockedAt);
    assert.ok(duringBlock.length>0,`a newly generated target must have an actual timestamp strictly inside the blocked Window interval: ${JSON.stringify({blockedAt,unblockedAt,commands:trace.motion.command_times_ms,fault:trace.fault})}`);
    assert.ok(duringBlock[0]>trace.motion.command_times_ms[0],"isolation evidence is new worker motion after the confirmed initial target, not a pre-stall total count");
    assert.equal(trace.timer_lateness.enabled,true,"integration uses the real independent owner timer");
    assert.deepEqual(JSON.parse(env.storageValues.get("motion-synth.adapter")),info);
    const cached=env.client.state(); cached.params.stroke=1;
    assert.equal(env.client.state().params.stroke,.1,"synchronous cached state is detached");
    assert.equal(env.terminated(),0); await env.shutdown(); assert.equal(env.terminated(),1);
  } finally {if(!env.terminated())await env.shutdown();}
});
test("Window heartbeat loss stops the worker independently of Window timers",async()=>{
  const env=owner();
  try {
    await connect(env);await env.client.request("/api/action",{action:"play"});
    await sleep(1650);
    const state=await env.client.request("/api/state");
    assert.equal(state.running,false);assert.match(state.fault,/heartbeat expired/);
    assert.equal(state.hardware.stop_confirmed,true);
  } finally {await env.shutdown();}
});
test("identical granted adapter identities fail closed without opening or moving a motor",async()=>{
  const env=owner({identities:[info,info]});
  try {
    await env.client.ready;
    await assert.rejects(env.client.choosePort(),/ambiguous/);
    const ports=await env.client.request("/api/ports");
    await assert.rejects(env.client.request("/api/action",{action:"connect",port:ports.ports[0].device}),/ambiguous/);
    assert.equal((await env.client.request("/api/state")).mode,"simulation");
  } finally {await env.shutdown();}
});
test("Stop fences an in-flight Play without awaiting its worker reply",async()=>{
  const env=owner({startDelay:100});
  try {
    await connect(env);
    const starting=env.client.request("/api/action",{action:"play"});
    const rejected=assert.rejects(starting,/stopped/i);
    await sleep(20);const state=await env.client.stop();await rejected;
    assert.equal(state.running,false);assert.equal(state.hardware.output_enabled,false);
    assert.equal(state.hardware.stop_confirmed,true);
    assert.equal((await env.client.request("/api/motion-diagnostics")).motion.commands,0);
  } finally {await env.shutdown();}
});
test("Stop cancels delayed worker adapter validation before it can open a connection",async()=>{
  const env=owner({catalogueDelay:30});
  try {
    await env.client.ready;const id=await env.client.choosePort();
    const connecting=env.client.request("/api/action",{action:"connect",port:id});
    const canceled=assert.rejects(connecting,/cancelled by Stop/);
    await sleep(5);await env.client.stop();await canceled;
    assert.equal((await env.client.request("/api/state")).mode,"simulation");
  } finally {await env.shutdown();}
});
