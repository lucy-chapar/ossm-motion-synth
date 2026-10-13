// SPDX-License-Identifier: MPL-2.0
// Offline trajectory capacity only. No browser, serial, or physical servo model.
"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const {Engine} = require("../virtual_synth/static/browser-engine.js");
const spanMm = 181.57 - 2 * 1638 / (32768/40);
const irregular = [.020,.031,.075,.024,.049,.061,.037,.055];
const wrap = phase => ((phase%1)+1)%1;
const reserve = .95, jerk = 100000;
// Independent symmetric S-curve minimum time, including jerk ramps.
function moveTime(distance, velocity, acceleration, maximumJerk) {
  const tj = Math.min(acceleration / maximumJerk, Math.sqrt(velocity / maximumJerk));
  const ta = Math.max(0, velocity / acceleration - tj), accelerating = 2 * tj + ta;
  if (distance >= velocity * accelerating) return distance / velocity + accelerating;
  if (distance <= 2 * acceleration ** 3 / maximumJerk ** 2) return 4 * Math.cbrt(distance / (2 * maximumJerk));
  return acceleration / maximumJerk + Math.sqrt((acceleration / maximumJerk) ** 2 + 4 * distance / acceleration);
}

function boundedEngine(params, acceleration=6000, velocity=1080) {
  const engine=new Engine(params);engine.reset({vmax:velocity/spanMm,amax:acceleration/spanMm,jmax:jerk/spanMm});
  const trajectory=engine.trajectory;
  for(const name of ["follow","track","update"]) {
    const method=trajectory[name].bind(trajectory);
    trajectory[name]=(target,dt,...args)=>{
      const before=trajectory.velocity, result=method(target,dt,...args);
      assert.ok(Math.abs(trajectory.velocity)<=trajectory.vmax+1e-9,"velocity bound");
      assert.ok(Math.abs(trajectory.velocity-before)<=trajectory.amax*dt+1e-8,"acceleration bound");
      assert.ok(trajectory.position>=trajectory.low-1e-9&&trajectory.position<=trajectory.high+1e-9,"position bound");
      if (name === "follow") {
        const stop=trajectory.braking();
        assert.ok(stop.minPosition>=trajectory.low-1e-9&&stop.maxPosition<=trajectory.high+1e-9,"jerk-aware stopping bound");
      } else {
        const stop=trajectory.position+trajectory.velocity*Math.abs(trajectory.velocity)/(2*trajectory.amax);
        assert.ok(stop>=trajectory.low-1e-9&&stop<=trajectory.high+1e-9,"legacy preview stopping bound");
      }
      return result;
    };
  }
  return engine;
}
function steady(engine,seconds=18) {
  let elapsed=0,index=0,min=Infinity,max=-Infinity,error2=0,n=0,signal;
  let referenceMin=Infinity,referenceMax=-Infinity;
  const p=engine.params,midpoint=p.lower+p.center*(p.upper-p.lower);
  const amplitude=p.stroke*Math.min(midpoint-p.lower,p.upper-midpoint);
  while(elapsed<seconds) {
    const dt=Math.min(irregular[index++%irregular.length],seconds-elapsed);elapsed+=dt;
    signal=engine.step(dt,{running:true,tracking:true});
    assert.ok(Number.isFinite(engine.reference_phase),"reference phase is inspectable");
    assert.ok(Number.isFinite(signal.planned_reference),"finite planned path is explicit");
    if(elapsed<=3)continue;
    min=Math.min(min,signal.command);max=Math.max(max,signal.command);
    const reference=signal.planned_reference;
    referenceMin=Math.min(referenceMin,reference);referenceMax=Math.max(referenceMax,reference);
    error2+=((signal.command-reference)*spanMm)**2;n++;
  }
  return {signal,min,max,span:(max-min)*spanMm,referenceSpan:(referenceMax-referenceMin)*spanMm,
    rms:Math.sqrt(error2/n),nominalSpan:2*amplitude*spanMm,elapsed};
}

test("1200 versus 6000 host acceleration changes feasible sine frequency without hiding its stroke",()=>{
  for(const [rate_hz,stroke] of [[1.5,.7],[2.5,.3]]) {
    const a=stroke*.4*spanMm;
    for(const acceleration of [1200,6000]) {
      const engine=boundedEngine({rate_hz,stroke,shape:"sine"},acceleration),r=steady(engine);
      const limit=Math.min(reserve*1080/(2*Math.PI*a),Math.sqrt(reserve*acceleration/a)/(2*Math.PI),Math.cbrt(reserve*jerk/a)/(2*Math.PI));
      const expected=Math.min(rate_hz,limit);
      assert.ok(Math.abs(r.signal.planned_rate_hz-expected)<1e-9,"analytic feasible rate");
      assert.equal(r.signal.rate_limited,acceleration===1200);
      assert.ok(Math.abs(r.span-r.nominalSpan)<r.nominalSpan*.01,"full requested stroke");
      assert.ok(r.rms<.5,"planner follows its planned sine reference");
    }
  }
});

test("an infeasible 4 Hz sine retimes its reference while the ideal requested phase continues",()=>{
  const engine=boundedEngine({rate_hz:4,stroke:.7,shape:"sine"}),r=steady(engine);
  const a=.7*.4*spanMm,expected=Math.sqrt(reserve*6000/a)/(2*Math.PI);
  assert.equal(r.signal.rate_limited,true);assert.ok(Math.abs(r.signal.planned_rate_hz-expected)<1e-9);
  assert.ok(Math.abs(r.span-r.nominalSpan)<r.nominalSpan*.01);assert.ok(r.rms<.5);
  assert.ok(Math.abs(engine.phase-wrap(4*r.elapsed))<1e-9,"requested oscillator keeps its original rate");
  assert.ok(Math.abs(engine.reference_phase-wrap(expected*r.elapsed))<1e-8,"planned oscillator follows its feasible rate");
});

test("square transitions reach both endpoints at 1.5 Hz within all motion bounds",()=>{
  const engine=boundedEngine({rate_hz:1.5,stroke:.7,shape:"square"}),r=steady(engine);
  assert.ok(Math.abs(r.signal.planned_rate_hz-1.5)<1e-9);
  assert.equal(r.signal.rate_limited,false);
  assert.ok(Math.abs(r.span-r.nominalSpan)<.001,"exact point planner reaches both endpoints");
});

test("square rate fits a jerk-bounded physical reversal in each half-cycle",()=>{
  for(const [velocity,acceleration] of [[1080,6000],[300,6000]]) {
    const engine=boundedEngine({rate_hz:4,stroke:.7,shape:"square"},acceleration,velocity),r=steady(engine);
    const distance=.7*.8*spanMm;
    const move=moveTime(distance,velocity*reserve,acceleration*reserve,jerk*reserve);
    assert.ok(Math.abs(r.signal.planned_rate_hz-1/(2*move))<1e-9);
    assert.equal(r.signal.rate_limited,true);
    assert.ok(Math.abs(r.span-r.nominalSpan)<r.nominalSpan*.01,"full stroke after frequency governing");
  }
});

test("finite triangle and saw paths preserve full 1.5 Hz stroke without exceeding the stroke endpoints",()=>{
  for(const shape of ["triangle","saw"]) {
    const engine=boundedEngine({rate_hz:1.5,stroke:.7,shape}),r=steady(engine);
    assert.ok(Math.abs(r.signal.planned_rate_hz-1.5)<1e-9);assert.equal(r.signal.rate_limited,false);
    assert.ok(Math.abs(r.span-r.nominalSpan)<r.nominalSpan*.01,shape+" full command span");
    assert.ok(Math.abs(r.referenceSpan-r.nominalSpan)<r.nominalSpan*.01,shape+" full finite reference span");
    assert.ok(r.rms<.5,shape+" follows its finite path");
    assert.ok(r.min>=.22-1e-9&&r.max<=.78+1e-9,shape+" avoids stroke overshoot");
  }
});

test("finite triangle and saw corners respect reference velocity and acceleration limits",()=>{
  for(const shape of ["triangle","saw"]) {
    const engine=boundedEngine({rate_hz:1.5,stroke:.7,shape});
    const dt=.002;let previous=null,previousVelocity=null;
    for(let i=0;i<2000;i++) {
      const s=engine.step(dt,{running:true,tracking:true}),x=s.planned_reference;
      assert.ok(x>=.22-1e-10&&x<=.78+1e-10,shape+" reference endpoint bound");
      if(previous!==null) {
        const velocity=(x-previous)/dt;
        assert.ok(Math.abs(velocity)<=engine.trajectory.vmax*reserve+1e-8,shape+" reserved reference velocity");
        if(previousVelocity!==null)assert.ok(Math.abs(velocity-previousVelocity)/dt<=engine.trajectory.amax*reserve+1e-7,shape+" reserved reference acceleration at corners");
        previousVelocity=velocity;
      }
      previous=x;
    }
  }
});

test("high-frequency finite triangle and saw paths govern their rate instead of losing stroke",()=>{
  for(const shape of ["triangle","saw"])for(const [velocity,acceleration] of [[1080,6000],[300,6000]]) {
    const engine=boundedEngine({rate_hz:4,stroke:.7,shape},acceleration,velocity),r=steady(engine);
    const distance=.7*.8*spanMm;
    const pathVelocity=velocity*reserve,pathAcceleration=acceleration*reserve;
    const move=moveTime(distance,pathVelocity,pathAcceleration,jerk*reserve);
    assert.ok(Math.abs(r.signal.planned_rate_hz-1/(2*move))<1e-9,shape+" feasible rate");
    assert.equal(r.signal.rate_limited,true);
    assert.ok(Math.abs(r.span-r.nominalSpan)<r.nominalSpan*.01,shape+" full stroke when governed");
    assert.ok(r.rms<.5,shape+" governed finite reference fidelity");
    assert.equal(engine.trajectory.vmax,velocity/spanMm,"capture reserve does not add an output velocity filter");
    assert.equal(engine.trajectory.amax,acceleration/spanMm,"capture reserve does not add an output acceleration filter");
  }
});

test("finite paths remain stoppable through signed modulation and abrupt geometry changes at 50–75 ms cadence",()=>{
  for(const shape of ["sine","triangle","saw","square"])for(const direction of [-1,1]) {
    const engine=boundedEngine({rate_hz:1.5,stroke:.7,shape,lfo_rate_hz:.3,patches:[
      {source:"lfo",target:"rate",depth:direction*.7},
      {source:"lfo",target:"stroke",depth:direction*.3},
      {source:"lfo",target:"center",depth:direction*.5},
    ]});
    for(let i=0;i<240;i++) {
      if(i===60)engine.configure({rate_hz:4,stroke:1,center:.05});
      if(i===120)engine.configure({rate_hz:.4,stroke:.15,center:.95});
      if(i===180)engine.configure({center:.5,env_to_stroke:true,patches:[
        {source:"envelope",target:"position",depth:direction},
      ]});
      const signal=engine.step(i%2?.075:.05,{running:true,tracking:true,gate:i%3!==0});
      assert.ok(Number.isFinite(signal.planned_reference));
      assert.ok(signal.planned_reference>=.1-1e-10&&signal.planned_reference<=.9+1e-10);
      if(signal.planned_rate_hz!==null)assert.ok(signal.planned_rate_hz<=signal.effective_rate_hz+1e-10);
    }
    const stopped=engine.step(0,{running:false,tracking:true});
    assert.equal(stopped.velocity,0);assert.equal(stopped.planned_rate_hz,null);assert.equal(stopped.rate_limited,false);
  }
});

test("capacity reporting makes center attenuation explicit without changing its geometry",()=>{
  const engine=boundedEngine({rate_hz:1.08,stroke:.62,center:.08,shape:"sine"});
  const signal=engine.step(.05,{running:true,tracking:true});
  assert.ok(Math.abs(signal.requested_span_normalized-.62*.8*2*.08)<1e-12);
  assert.equal(signal.center_limited_stroke,true);
  assert.ok(Math.abs(signal.requested_span_normalized/.8-.62*2*.08)<1e-12,"9.92% of working window");
  const a=signal.requested_span_normalized*spanMm/2;
  assert.ok(Math.abs(signal.max_sine_rate_hz-Math.min(reserve*1080/(2*Math.PI*a),Math.sqrt(reserve*6000/a)/(2*Math.PI),Math.cbrt(reserve*jerk/a)/(2*Math.PI)))<1e-9);
});

test("hardware reset clears both oscillator phases and planned rate state",()=>{
  const engine=boundedEngine({rate_hz:4,stroke:.7,shape:"sine"});engine.step(.17,{running:true,tracking:true});
  assert.notEqual(engine.phase,0);assert.notEqual(engine.reference_phase,0);
  engine.reset();
  assert.equal(engine.phase,0);assert.equal(engine.reference_phase,0);
  const signal=engine.step(0,{running:false,tracking:true});
  assert.equal(signal.planned_rate_hz,null);
});

test("zero stroke and centered geometry report capacity without invalid rates",()=>{
  const engine=boundedEngine({rate_hz:4,stroke:0,shape:"sine"});
  const signal=engine.step(.05,{running:true,tracking:true});
  assert.equal(signal.requested_span_normalized,0);assert.equal(signal.center_limited_stroke,false);
  assert.equal(signal.planned_rate_hz,4);assert.equal(signal.rate_limited,false);
  assert.equal(signal.command,.5);assert.equal(signal.velocity,0);
});

test("position-patch span uses its depth magnitude and never reports an oscillator capacity",()=>{
  for(const depth of [0,-.4,.4]) {
    const engine=boundedEngine({rate_hz:4,stroke:.7,shape:"triangle",patches:[
      {source:"lfo",target:"position",depth},
    ]});
    const signal=engine.step(.075,{running:true,tracking:true});
    assert.ok(Math.abs(signal.requested_span_normalized-.7*.8*Math.abs(depth))<1e-12);
    assert.equal(signal.planned_rate_hz,null);assert.equal(signal.max_sine_rate_hz,null);
    assert.equal(signal.rate_limited,false);assert.equal(signal.position_patched,true);
  }
});

function finiteCapacity(signal) {
  for(const field of ["command","velocity","requested","planned_reference","phase","reference_phase","requested_span_normalized"])
    assert.ok(Number.isFinite(signal[field]),field+" remains finite");
  if(signal.planned_rate_hz!==null) {
    assert.ok(Number.isFinite(signal.planned_rate_hz)&&signal.planned_rate_hz>0,"finite positive governed rate");
    assert.ok(signal.planned_rate_hz<=signal.effective_rate_hz+1e-10,"governing never speeds up the request");
  }
  if(signal.max_sine_rate_hz!==null)assert.ok(Number.isFinite(signal.max_sine_rate_hz)&&signal.max_sine_rate_hz>0,"finite sine capacity");
}

test("zero and tiny strokes at both center boundaries remain finite and transition to full travel",()=>{
  for(const shape of ["sine","triangle","saw","square"])for(const center of [0,.5,1])for(const stroke of [0,Number.MIN_VALUE,1e-20,1e-12]) {
    const engine=boundedEngine({shape,center,stroke,rate_hz:4});
    for(let i=0;i<8;i++)finiteCapacity(engine.step(i%2?.075:.05,{running:true,tracking:true}));
    engine.configure({stroke:1,center:.5});
    for(let i=0;i<12;i++)finiteCapacity(engine.step(i%2?.075:.05,{running:true,tracking:true}));
  }
});

test("representable microscopic geometry at a zero rail boundary keeps capacity arithmetic finite",()=>{
  for(const shape of ["sine","triangle","saw","square"])for(const center of [Number.MIN_VALUE,1e-310,1e-200]) {
    const engine=boundedEngine({shape,center,stroke:1,lower:0,upper:1,rate_hz:4});
    for(let i=0;i<4;i++)finiteCapacity(engine.step(.02,{running:true,tracking:true}));
    engine.configure({center:.5});
    for(let i=0;i<4;i++)finiteCapacity(engine.step(.075,{running:true,tracking:true}));
  }
});

test("tiny signed position depths and collapsed stroke geometry do not introduce invalid references",()=>{
  for(const shape of ["sine","triangle","saw","square"])for(const source of ["lfo","envelope"])for(const stroke of [1e-20,.7])for(const depth of [0,-1e-20,1e-20,-1e-12,1e-12]) {
    const engine=boundedEngine({shape,stroke,rate_hz:4,env_to_stroke:true,
      patches:[{source,target:"position",depth}]});
    for(let i=0;i<8;i++) {
      const signal=engine.step(i%2?.075:.05,{running:true,tracking:true,gate:i<4});
      finiteCapacity(signal);assert.equal(signal.planned_rate_hz,null);assert.equal(signal.max_sine_rate_hz,null);
    }
  }
});

test("tiny finite triangle references survive deterministic geometry changes without a rounding fault",()=>{
  const engine=boundedEngine({shape:"triangle",stroke:1e-12,center:.9273538051638752,rate_hz:2.3558033170038835});
  for(let i=0;i<20;i++)finiteCapacity(engine.step(irregular[i%irregular.length],{running:true,tracking:true}));
  let seed=42;
  const random=()=>((seed=Math.imul(seed,1664525)+1013904223>>>0)/4294967296);
  for(let i=0;i<2000;i++) {
    if(i%5===0)engine.configure({shape:["sine","triangle","saw","square"][Math.floor(random()*4)],
      stroke:[0,1e-12,.001,1][Math.floor(random()*4)],center:[0,1,random()][Math.floor(random()*3)],
      rate_hz:.02+3.98*random()});
    finiteCapacity(engine.step(.001+.074*random(),{running:true,tracking:true}));
  }
});

test("capacity metadata does not change nontracking simulation signals",()=>{
  const engine=new Engine({rate_hz:1.5,stroke:.7,shape:"sine"});
  const signal=engine.step(.05,{running:true,tracking:false});
  for(const key of ["reference_phase","planned_reference","planned_rate_hz","rate_limited","requested_span_normalized","center_limited_stroke","max_sine_rate_hz"]) {
    assert.equal(Object.hasOwn(signal,key),false);
  }
});
