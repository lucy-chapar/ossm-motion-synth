// SPDX-License-Identifier: MPL-2.0
"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {createClient}=require("../virtual_synth/static/worker-client.js");
function state(revision=0,hardware=null) {return {mode:hardware?"hardware":"simulation",params:{stroke:.3},running:false,armed:false,
  homing:{active:false},hardware,control_revision:revision,unconfirmed_stop:false};}
function bridge({picker}={}) {
  const listeners={},sent=[];let terminated=0;
  const worker={addEventListener:(name,listener)=>{listeners[name]=listener;},postMessage:message=>sent.push(message),terminate:()=>{terminated++;}};
  const client=createClient({storage:null,serial:{requestPort:picker || (async()=>({getInfo:()=>({usbVendorId:1,usbProductId:2})}))},workerFactory:()=>worker});
  function answer(message,value,ok=true){listeners.message({data:{id:message.id,ok,value,error:ok?undefined:String(value)}});}
  answer(sent[0],{supported:true,state:state()});
  return {client,sent,answer,listeners,terminated:()=>terminated};
}
test("worker client cancels a pending Window picker through the normal Stop request route",async()=>{
  let finish;const env=bridge({picker:()=>new Promise(resolve=>{finish=resolve;})});
  await env.client.ready;const choosing=env.client.choosePort();
  const canceled=assert.rejects(choosing,/cancelled/);
  const stopping=env.client.request("/api/action",{action:"stop"});await Promise.resolve();
  env.answer(env.sent.at(-1),state(1));await stopping;
  finish({getInfo:()=>({usbVendorId:1,usbProductId:2})});await canceled;
  assert.equal(env.sent.some(message=>message.type==="choose"),false);
});
test("worker failure rejects pending controls and preserves uncertainty about motor output",async()=>{
  const env=bridge();await env.client.ready;
  const polling=env.client.request("/api/state");await Promise.resolve();
  env.answer(env.sent.at(-1),state(2,{connected:true,owned:false,output_enabled:false,stop_confirmed:true}));await polling;
  const playing=env.client.request("/api/action",{action:"play"});const rejected=assert.rejects(playing,/worker failed/i);await Promise.resolve();
  env.listeners.error({});await rejected;
  const failed=await env.client.request("/api/state");
  assert.equal(failed.unconfirmed_stop,true);assert.equal(failed.hardware.stop_confirmed,false);
  assert.equal(env.client.supported,false);assert.equal(env.terminated(),0);
  assert.equal(env.client.mustStopBeforeClose,true);
  await assert.rejects(env.client.close(),/worker failed/i);assert.equal(env.terminated(),0);
});
test("close protection covers Play and Home immediately before a worker state reply",async()=>{
  for(const action of ["play","arm","run","resume","home_start"]) {
    const env=bridge();
    assert.equal(env.client.mustStopBeforeClose,false);
    const moving=env.client.request("/api/action",{action});
    assert.equal(env.client.mustStopBeforeClose,true,`${action} before readiness continuation`);
    await env.client.ready;await Promise.resolve();
    assert.equal(env.client.mustStopBeforeClose,true,`${action} before state reply`);
    env.answer(env.sent.at(-1),{...state(1),running:true,armed:true});await moving;
    assert.equal(env.client.mustStopBeforeClose,true,`${action} now owns active motion`);
    const stopped=env.client.stop();await Promise.resolve();
    env.answer(env.sent.at(-1),state(2));await stopped;
    assert.equal(env.client.mustStopBeforeClose,false);
  }
});
test("idle read-only Connect and adapter selection do not require stopped-owner close protection",async()=>{
  let finish;const env=bridge({picker:()=>new Promise(resolve=>{finish=resolve;})});await env.client.ready;
  assert.equal(env.client.mustStopBeforeClose,false);
  const connecting=env.client.request("/api/action",{action:"connect"});
  assert.equal(env.client.mustStopBeforeClose,false);await Promise.resolve();
  env.answer(env.sent.at(-1),state(1,{connected:true,owned:false,output_enabled:false,stop_confirmed:false}));await connecting;
  assert.equal(env.client.mustStopBeforeClose,false);
  const choosing=env.client.choosePort();assert.equal(env.client.mustStopBeforeClose,false);
  finish({getInfo:()=>({usbVendorId:1,usbProductId:2})});
  await Promise.resolve();await Promise.resolve();
  env.answer(env.sent.at(-1),{ports:[]});await choosing;
  assert.equal(env.client.mustStopBeforeClose,false);
});
test("close protection retains every active or uncertain worker owner until a stopped unowned state",async()=>{
  const cases=[{hardware:{owned:true}},{armed:true},{running:true},{homing:{active:true}},
    {stopping:true},{unconfirmed_stop:true}];
  for(const flags of cases) {
    const env=bridge();await env.client.ready;
    const poll=env.client.request("/api/state");await Promise.resolve();
    env.answer(env.sent.at(-1),{...state(1),...flags});await poll;
    assert.equal(env.client.mustStopBeforeClose,true,JSON.stringify(flags));
    const safe=env.client.request("/api/state");await Promise.resolve();
    env.answer(env.sent.at(-1),state(2));await safe;
    assert.equal(env.client.mustStopBeforeClose,false);
  }
});
test("a failed motion reply cannot drop close protection on an older pending stopped snapshot",async()=>{
  const env=bridge();await env.client.ready;
  const oldPoll=env.client.request("/api/state");await Promise.resolve();const old=env.sent.at(-1);
  const home=env.client.request("/api/action",{action:"home_start"});
  const rejected=assert.rejects(home,/Home failed/);await Promise.resolve();
  env.answer(env.sent.at(-1),"Home failed",false);await rejected;
  assert.equal(env.client.mustStopBeforeClose,true);
  env.answer(old,state(1));await oldPoll;
  assert.equal(env.client.mustStopBeforeClose,true,"pre-error poll cannot prove post-error ownership");
  const fresh=env.client.request("/api/state");await Promise.resolve();
  env.answer(env.sent.at(-1),state(2));await fresh;
  assert.equal(env.client.mustStopBeforeClose,false);
});
test("older worker state replies cannot overwrite a newer Stop epoch",async()=>{
  const env=bridge();await env.client.ready;
  const poll=env.client.request("/api/state");await Promise.resolve();const old=env.sent.at(-1);
  const stop=env.client.stop();await Promise.resolve();env.answer(env.sent.at(-1),state(3));await stop;
  env.answer(old,{...state(2),running:true,armed:true});
  assert.equal((await poll).running,false);assert.equal(env.client.state().control_revision,3);
});
test("worker client never terminates on incomplete or contradictory shutdown evidence",async()=>{
  for(const evidence of [{connected:true,owned:false,output_enabled:false,stop_confirmed:true},
    {connected:false,owned:false,output_enabled:false,stop_confirmed:false},
    {connected:false,owned:false,output_enabled:true,stop_confirmed:true}]) {
    const env=bridge();await env.client.ready;
    const closing=env.client.close(),rejected=assert.rejects(closing,/confirm stopped and closed/);await Promise.resolve();
    env.answer(env.sent.at(-1),{closed:true,state:state(1,evidence)});await rejected;assert.equal(env.terminated(),0);
  }
});
