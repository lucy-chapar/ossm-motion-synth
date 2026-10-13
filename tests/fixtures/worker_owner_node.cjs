// SPDX-License-Identifier: MPL-2.0
// Dedicated-worker integration fixture: actual browser runtime and local WASM;
// all serial adapters and motor feedback are fake and remain in this thread.
"use strict";
const {parentPort, workerData} = require("node:worker_threads");
const fs = require("node:fs"), vm = require("node:vm"), path = require("node:path");
const directory = path.join(__dirname, "../../virtual_synth/static");
const listeners = new Map();
let runtime;
const ports = (workerData.identities || [{usbVendorId:0x1a86,usbProductId:0x7523}]).map(info => ({getInfo: () => info}));
const motor = {
  hw: { connected:false, homed:true, mode:1, owned:false, armed:false, running:false,
    homing:false, fault:null, output_enabled:false, stop_confirmed:true, pending_raw:0, pwm_raw:0,
    position_normalized:.5, raw_bounds:[1000,20660], max_velocity_raw_s:73728,
    max_acceleration_raw_s2:147456, max_jerk_raw_s3:81920000 },
  commands: 0, firstCommand:null, lastCommand:null, commandTimes:[],
  status() { return {...this.hw,command_count:this.commands}; },
  async connect() { this.hw.connected=true; return this.status(); },
  async arm() { this.hw.armed=true; return this.status(); },
  async start() { this.hw.owned=this.hw.running=true; this.hw.output_enabled=true; this.hw.stop_confirmed=false;
    await new Promise(resolve=>setTimeout(resolve,workerData.startDelay || 0)); return this.status(); },
  async command(resolve) {
    this.hw.position_normalized=typeof resolve === "function" ? resolve() : resolve;
    this.commands++; this.firstCommand ??= performance.now(); this.lastCommand=performance.now();
    if(this.commandTimes.length===512)this.commandTimes.shift();
    this.commandTimes.push(performance.timeOrigin+performance.now());
    await new Promise(resolve=>setTimeout(resolve,5)); return this.status();
  },
  async snapshot() { return this.status(); },
  async stop() { this.hw.running=this.hw.armed=this.hw.owned=this.hw.homing=false; this.hw.output_enabled=false; this.hw.stop_confirmed=true; return this.status(); },
  async close() { this.hw.connected=false; },
  motionDiagnostics() { return {commands:this.commands,firstCommand:this.firstCommand,lastCommand:this.lastCommand,
    command_times_ms:this.commandTimes.slice(),stop_confirmed:this.hw.stop_confirmed}; },
};
const context = vm.createContext({
  console, URL, WebAssembly, ArrayBuffer, Uint8Array, Float64Array, DataView, BigInt,
  performance, structuredClone, queueMicrotask, MessageChannel, setTimeout, clearTimeout, setInterval, clearInterval,
  location:{href:"https://offline.test/apps/worker.js"},
  navigator:{serial:{getPorts:async()=>{if(workerData.catalogueDelay)await new Promise(resolve=>setTimeout(resolve,workerData.catalogueDelay));return ports;},addEventListener(){},removeEventListener(){}}},
  fetch:async()=>({ok:true,arrayBuffer:async()=>{const data=fs.readFileSync(path.join(directory,"ruckig-core.wasm"));return data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength);}}),
  postMessage: message=>parentPort.postMessage(message),
  addEventListener:(name,listener)=>listeners.set(name,listener),
});
context.importScripts=(...urls)=>{
  for(const url of urls) vm.runInContext(fs.readFileSync(path.join(directory,url.split("?")[0]),"utf8"),context,{filename:url});
  const create=context.MotionBrowserRuntimeAPI.createRuntime;
  context.MotionBrowserRuntimeAPI.createRuntime=options=>{
    runtime=create({...options,transportFactory:port=>{
      if (!ports.includes(port)) throw new Error("Window cannot supply or own this worker's SerialPort.");
      return motor;
    }});
    return runtime;
  };
};
vm.runInContext(fs.readFileSync(path.join(directory,"worker.js"),"utf8"),context,{filename:"worker.js"});
parentPort.on("message",message=>{
  // JSON is sufficient for these bounded RPC inputs and creates objects in
  // the receiving realm, like browser structured cloning does.
  const received=vm.runInContext(`JSON.parse(${JSON.stringify(JSON.stringify(message))})`,context);
  listeners.get("message")({data:received});
});
