// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const io = require("../virtual_synth/static/web-serial-io.js");
const { WebSerialConnection, TransportError, frame, snapshotRequest, parseSnapshot,
  signedPosition, pending, absoluteRequest, outputRequest, configRequest } = io;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function snapshot(values = Array(26).fill(0)) {
  return frame([1, 3, 52, ...values.flatMap(value => [value >>> 8, value & 255])]);
}
function ack(tx) { return frame([...tx.slice(0, 6)]); }
class FakePort {
  constructor(onWrite = (tx, port) => port.emit(tx[1] === 3 ? snapshot() : ack(tx))) {
    this.opens = []; this.writes = []; this.closes = 0; this.cancelled = 0; this.aborted = 0;
    this.onWrite = onWrite;
    this.readable = new ReadableStream({
      start: controller => { this.input = controller; },
      cancel: () => { this.cancelled++; },
    });
    this.writable = new WritableStream({
      write: async value => { const tx = Uint8Array.from(value); this.writes.push(tx); await this.onWrite(tx, this); },
      abort: () => { this.aborted++; },
    });
  }
  emit(data) { this.input.enqueue(Uint8Array.from(data)); }
  async open(options) { this.opens.push(options); }
  async close() { this.closes++; }
}

function timedConnection(port, { onWait = null, onClock = null } = {}) {
  const timing = { time: 0, waits: [], writes: [], onWait };
  const onWrite = port.onWrite;
  port.onWrite = (tx, owner) => { timing.writes.push(timing.time); return onWrite(tx, owner); };
  const connection = new WebSerialConnection(port, {
    baudRate: 115200,
    clock: () => { onClock?.(); return timing.time; },
    wait: async milliseconds => {
      assert.ok(milliseconds > 0, "quiet waits must advance time");
      timing.waits.push(milliseconds); timing.time += milliseconds;
      timing.onWait?.(milliseconds);
      await Promise.resolve(); // Deliver queued receive chunks through the sole reader.
    },
  });
  return { connection, timing };
}

test("position gain requests permit only fixed volatile gain 3000, including raw-frame validation", async () => {
  const request = frame([1,6,0,7,11,184]);
  assert.deepEqual(configRequest(7,3000), request);
  for (const gain of [0,60,2999,3001,4000,6000,30000,65535,3000.5,NaN]) assert.throws(() => configRequest(7,gain), /Unsupported/);
  const port = new FakePort(), {connection} = timedConnection(port);
  try {
    await connection.open();
    for (const gain of [0,60,2999,3001,4000,6000,30000,65535]) {
      await assert.rejects(connection.exchange(frame([1,6,0,7,gain >>> 8,gain & 255])), /outside the supported/);
    }
    assert.deepEqual(port.writes, []);
    assert.deepEqual(await connection.exchange(request), request);
    assert.deepEqual(port.writes, [request]);
  } finally { await connection.close(); }
});

test("numeric exchange timing distinguishes fragmented early RX from delayed writer settlement", async () => {
  const response = frame([1,0x7b,0,1,0,0]);
  let timing;
  const port = new FakePort(async (_,owner) => {
    timing.time += 3; owner.emit(response.slice(0,3)); await Promise.resolve();
    timing.time += 2; owner.emit(response.slice(3)); await Promise.resolve();
    timing.time += 10;
  });
  const context = timedConnection(port), {connection} = context; timing = context.timing;
  const tuple = connection.exchangeTiming;
  try {
    await connection.open(); const submitted = timing.time;
    assert.deepEqual(await connection.exchange(io.fastPositionRequest(123)),response);
    assert.equal(connection.exchangeTiming,tuple,"the same fixed numeric tuple is reused");
    assert.deepEqual(Array.from(tuple),[1,0x7b,submitted,submitted+15,submitted+3,submitted+5,submitted+15]);
    assert.equal(port.writes.length,1); assert.equal(connection.poisoned,false);
  } finally { await connection.close(); }
});

test("numeric exchange timing identifies delayed RX after an already-settled write", async () => {
  const response = frame([1,0x7b,0,1,0,0]), port = new FakePort(() => {});
  const {connection,timing} = timedConnection(port);
  try {
    await connection.open(); const submitted = timing.time;
    const exchange = connection.exchange(io.fastPositionRequest(123));
    for (let i = 0; i < 20 && !Number.isFinite(connection.exchangeTiming[3]); i++) await Promise.resolve();
    assert.equal(connection.exchangeTiming[3],submitted); assert.ok(Number.isNaN(connection.exchangeTiming[4]));
    timing.time += 20; port.emit(response); assert.deepEqual(await exchange,response);
    assert.deepEqual(Array.from(connection.exchangeTiming),[1,0x7b,submitted,submitted,submitted+20,submitted+20,submitted+20]);
    assert.equal(port.writes.length,1);
  } finally { await connection.close(); }
});

test("timing validity resets for failed, recovered and cancelled exchanges without stale RX metadata", async () => {
  const response = frame([1,0x7b,0,1,0,0]), bad = response.slice(); bad[6] ^= 1;
  const port = new FakePort((_,owner) => owner.emit(bad)), {connection,timing} = timedConnection(port);
  try {
    await connection.open(); const tuple = connection.exchangeTiming;
    await assert.rejects(connection.exchange(io.fastPositionRequest(123)),/CRC/);
    assert.equal(tuple[0],1); assert.ok(Number.isFinite(tuple[4])); assert.ok(Number.isNaN(tuple[6]));
    const failedRx = tuple[4];
    port.onWrite = (_,owner) => { timing.time += 4; owner.emit(response); };
    assert.deepEqual(await connection.exchange(io.fastPositionRequest(124)),response);
    assert.equal(connection.exchangeTiming,tuple); assert.equal(tuple[0],2); assert.equal(tuple[1],0x7b);
    assert.ok(tuple[2] > failedRx); assert.equal(tuple[4],tuple[2]+4); assert.equal(tuple[5],tuple[4]); assert.ok(Number.isFinite(tuple[6]));
    await assert.rejects(connection.exchange(outputRequest("inhibit"),.1,() => { throw new TransportError("Operation cancelled by Stop."); }),/cancelled/);
    assert.equal(tuple[0],3); assert.equal(tuple[1],6);
    assert.ok(Array.from(tuple.slice(2)).every(Number.isNaN)); assert.equal(port.writes.length,2);
  } finally { await connection.close(); }
});

test("clean dedicated FC7b pairs have zero artificial quiet wait and retain one reader", async () => {
  const response = frame([1, 0x7b, 0, 1, 0, 0]);
  const port = new FakePort((_, owner) => owner.emit(response));
  let readers = 0;
  const getReader = port.readable.getReader.bind(port.readable);
  port.readable.getReader = (...args) => { readers++; return getReader(...args); };
  const { connection, timing } = timedConnection(port);
  try {
    await connection.open();
    assert.ok(timing.time >= 160, "startup quarantine must remain in force");
    timing.waits.length = 0;
    await connection.exchange(io.fastPositionRequest(123), .1);
    for (const target of [124, 125, 126]) assert.deepEqual(await connection.exchange(io.fastPositionRequest(target), .1), response);
    assert.deepEqual(timing.waits, []);
    assert.deepEqual(timing.writes, Array(4).fill(timing.time));
    assert.equal(readers, 1);
  } finally { await connection.close(); }
});

test("lazy FC7b frames sample after the ordinary transition quiet wait and retain the clean fast path", async () => {
  const port = new FakePort(), {connection, timing} = timedConnection(port);
  try {
    await connection.open(); await connection.exchange(snapshotRequest());
    const before = timing.time;
    let sampledAt = null, resolved = 0;
    // Model a delayed browser task while the final ordinary idle wait runs.
    timing.onWait = () => { timing.time += 75; timing.onWait = null; };
    await connection.exchange(io.fastPositionRequest(123), .1, () => {
      resolved++; sampledAt = timing.time;
      return io.fastPositionRequest(Math.round(sampledAt));
    });
    assert.equal(sampledAt, before + 77);
    assert.equal(resolved, 1);
    assert.deepEqual(port.writes.at(-1), io.fastPositionRequest(Math.round(sampledAt)));
    assert.notDeepEqual(port.writes.at(-1), io.fastPositionRequest(123), "the placeholder never reaches the wire");
    assert.equal(timing.writes.at(-1), sampledAt, "no await separates frame sampling from native submission");
    timing.waits.length = 0;
    await connection.exchange(io.fastPositionRequest(123), .1, () => io.fastPositionRequest(456));
    assert.deepEqual(timing.waits, []);
    assert.deepEqual(port.writes.at(-1), io.fastPositionRequest(456));
  } finally { await connection.close(); }
});

test("lazy replacement validates the actual frame and cannot change ordinary protocol operations", async () => {
  const invalidCRC = io.fastPositionRequest(456); invalidCRC[7] ^= 1;
  const cases = [
    [io.fastPositionRequest(123), invalidCRC, /CRC/],
    [io.fastPositionRequest(123), frame([1, 0x7b, 0, 0, 0, 0]), /supported motor protocol/],
    [io.fastPositionRequest(123), configRequest(2, 7), /Only a dedicated position/],
    [configRequest(2, 7), io.fastPositionRequest(456), /Only a dedicated position/],
    [io.fastPositionRequest(123), [1, 0x7b, 256], /Invalid byte/],
  ];
  for (const [placeholder, replacement, expected] of cases) {
    const port = new FakePort(), {connection} = timedConnection(port);
    try {
      await connection.open();
      await assert.rejects(connection.exchange(placeholder, .1, () => replacement), expected);
      assert.deepEqual(port.writes, [], "an invalid actual frame cannot transmit its placeholder");
      assert.equal(connection._resyncAfter, null, "nothing was written or left uncertain");
    } finally { await connection.close(); }
  }
});

test("ordinary Modbus boundary waits only the unelapsed portion since the final received chunk", async () => {
  const port = new FakePort(), { connection, timing } = timedConnection(port);
  try {
    await connection.open();
    await connection.exchange(configRequest(2, 7));
    const received = connection._lastReceiveAt;
    timing.time += .75; timing.waits.length = 0;
    await connection.exchange(configRequest(3, 15));
    assert.deepEqual(timing.waits, [1.25]);
    assert.equal(timing.writes[1] - received, 2);
    timing.time += 3; timing.waits.length = 0;
    await connection.exchange(configRequest(2, 7));
    assert.deepEqual(timing.waits, [], "a caller arriving after the required gap needs no new quiet delay");
  } finally { await connection.close(); }
});

test("ordinary guard-to-target and target-to-guard transitions retain the 2 ms boundary", async () => {
  const port = new FakePort((tx, owner) => owner.emit(tx[1] === 3
    ? frame([1, 3, tx[5] * 2, ...Array(tx[5] * 2).fill(0)]) : ack(tx)));
  const { connection, timing } = timedConnection(port);
  try {
    await connection.open();
    await connection.exchange(io.statusRequest(0, 7));
    timing.waits.length = 0;
    await connection.exchange(io.fastPositionRequest(123));
    assert.deepEqual(timing.waits, [2]);
    timing.waits.length = 0;
    await connection.exchange(io.fastPositionRequest(124));
    assert.deepEqual(timing.waits, []);
    await connection.exchange(io.statusRequest(7, 7));
    assert.deepEqual(timing.waits, [2]);
    assert.deepEqual(timing.writes.map(time => time - timing.writes[0]), [0, 2, 2, 4]);
  } finally { await connection.close(); }
});

test("fractional receive timestamps finish the exact 2 ms boundary without a clock-resolution spin", async () => {
  for (const arriveQuiet of [false, true]) {
    let monitorClock = false, clockReads = 0;
    const port = new FakePort(), { connection, timing } = timedConnection(port, {
      onClock() {
        if (monitorClock) assert.ok(++clockReads < 100, "An already-satisfied quiet boundary must not spin waiting for another clock tick");
      },
    });
    try {
      await connection.open();
      timing.time = 254.02;
      await connection.exchange(snapshotRequest());
      const receivedAt = timing.time, quietAt = receivedAt + 2;
      assert.ok(quietAt - receivedAt < 2, "Fixture crosses a floating-point precision boundary");
      if (arriveQuiet) timing.time = quietAt;
      timing.waits.length = 0; monitorClock = true;
      await connection.exchange(io.fastPositionRequest(123));
      monitorClock = false;
      assert.deepEqual(timing.waits, arriveQuiet ? [] : [quietAt - receivedAt]);
      assert.equal(timing.writes.at(-1), quietAt, "Native submission still waits until the absolute 2 ms boundary");
      assert.equal(port.writes.length, 2, "There is one request per exchange");
    } finally { monitorClock = false; await connection.close(); }
  }
});

test("new unsolicited ordinary input moves the idle boundary to its receive time", async () => {
  const port = new FakePort(), { connection, timing } = timedConnection(port);
  try {
    await connection.open(); await connection.exchange(configRequest(2, 7));
    timing.time += .25; timing.waits.length = 0;
    let injected = false;
    timing.onWait = () => { if (!injected) { injected = true; port.emit([99]); } };
    await connection.exchange(configRequest(3, 15));
    assert.deepEqual(timing.waits, [1.75, 2]);
    assert.equal(timing.writes[1] - timing.writes[0], 4);
    assert.equal(connection._buffer.length, 0);
  } finally { await connection.close(); }
});

test("startup keeps 150 ms quarantine followed by 10 ms silence without a request", async () => {
  const port = new FakePort(), { connection, timing } = timedConnection(port);
  let late = false;
  timing.onWait = () => { if (timing.time >= 160 && !late) { late = true; port.emit([255, 1, 3]); } };
  try {
    await connection.open();
    assert.equal(timing.time, 170, "late startup bytes restart the final 10 ms silence");
    assert.equal(connection._buffer.length, 0);
    assert.equal(connection._resyncAfter, null);
    assert.equal(port.writes.length, 0);
  } finally { await connection.close(); }
});

test("buffered junk after a clean fast reply prevents a new target and quarantines the original reply window", async () => {
  const port = new FakePort(), { connection, timing } = timedConnection(port);
  try {
    await connection.open();
    await connection.exchange(io.fastPositionRequest(123), .05);
    const deadline = connection._lastResponseDeadline;
    port.emit([99]); await Promise.resolve();
    timing.waits.length = 0;
    let guarded = 0;
    await assert.rejects(connection.exchange(io.fastPositionRequest(124), .05, () => guarded++),
      error => error.recoverableResponse === true && /inter-frame.*no new request/.test(error.message));
    assert.equal(guarded, 0); assert.equal(port.writes.length, 1);
    assert.equal(connection._resyncAfter, deadline);
    assert.deepEqual(timing.waits, []);
    await connection.exchange(outputRequest("inhibit"), .1, () => guarded++);
    assert.equal(timing.writes[1], deadline + 10);
    assert.equal(guarded, 1);
    assert.deepEqual(port.writes.map(tx => tx[1]), [0x7b, 6]);
    assert.equal(connection._buffer.length, 0);
  } finally { await connection.close(); }
});

test("fast response failures retain the original deadline and 10 ms recovery before independent inhibit", async () => {
  for (const failure of ["function", "crc", "trailing"]) {
    const port = new FakePort((tx, owner) => {
      if (owner.writes.length === 1) {
        if (failure === "function") owner.emit(ack(configRequest(2, 7)));
        else {
          const response = ack(tx);
          if (failure === "crc") response[7] ^= 1;
          owner.emit(failure === "trailing" ? [...response, 99] : response);
        }
      } else owner.emit(ack(tx));
    });
    const { connection, timing } = timedConnection(port);
    try {
      await connection.open();
      await assert.rejects(connection.exchange(io.fastPositionRequest(123), .05), /function|CRC|trailing/);
      const deadline = connection._lastResponseDeadline;
      assert.equal(port.writes.length, 1, "an uncertain write is never repeated");
      let late = false;
      timing.onWait = () => { if (timing.time >= deadline && !late) { late = true; port.emit([77, 88]); } };
      await connection.exchange(outputRequest("inhibit"));
      assert.equal(timing.writes[1], deadline + 10);
      assert.deepEqual(port.writes.map(tx => tx[1]), [0x7b, 6]);
      assert.equal(connection._buffer.length, 0);
    } finally { await connection.close(); }
  }
});

test("Stop cancels a contiguous fast write and a write waiting for ordinary quiet", async () => {
  for (const transition of ["fast", "ordinary"]) {
    const port = new FakePort(), { connection, timing } = timedConnection(port);
    try {
      await connection.open(); await connection.exchange(io.fastPositionRequest(123));
      let stopped = transition === "fast", guarded = 0;
      timing.onWait = () => { stopped = true; };
      await assert.rejects(connection.exchange(transition === "fast" ? io.fastPositionRequest(124) : configRequest(2, 7), .1, () => {
        guarded++; if (stopped) throw new TransportError("Operation cancelled by Stop.");
      }), /cancelled/);
      assert.equal(guarded, 1); assert.equal(port.writes.length, 1);
      timing.onWait = null;
      await connection.exchange(outputRequest("inhibit"));
      assert.deepEqual(port.writes.map(tx => tx[1]), [0x7b, 6]);
    } finally { await connection.close(); }
  }
});

test("construction is inert, open preserves the default serial profile, close releases locks", async () => {
  const port = new FakePort(), connection = new WebSerialConnection(port);
  assert.equal(port.opens.length, 0);
  assert.equal(port.writes.length, 0);
  await assert.rejects(connection.exchange(snapshotRequest()), /closed/);
  await connection.open();
  assert.deepEqual(port.opens, [{ baudRate: 19200, dataBits: 8, stopBits: 1, parity: "none", flowControl: "none" }]);
  assert.equal(port.writes.length, 0);
  await connection.close();
  assert.equal(port.readable.locked, false);
  assert.equal(port.writable.locked, false);
  assert.equal(port.closes, 1);
  assert.equal(port.writes.length, 0);
  await connection.close();
  assert.equal(port.closes, 1);
});

test("allowed host baud rates preserve the remaining serial profile without sending requests", async () => {
  for (const baudRate of [19200, 38400, 115200]) {
    const port = new FakePort(), connection = new WebSerialConnection(port, { baudRate });
    assert.equal(port.opens.length, 0);
    try {
      await connection.open();
      assert.deepEqual(port.opens, [{ baudRate, dataBits: 8, stopBits: 1, parity: "none", flowControl: "none" }]);
      assert.equal(connection.baudRate, baudRate);
      assert.equal(port.writes.length, 0);
    } finally { await connection.close(); }
  }
});

test("unsupported or noninteger host baud rates are rejected before opening the port", () => {
  for (const baudRate of [9600, 57600, 0, -1, 19200.5, NaN, Infinity, "19200", null, true, {}, 115200n]) {
    const port = new FakePort();
    assert.throws(() => new WebSerialConnection(port, { baudRate }), error => error instanceof TransportError && /baud/.test(error.message));
    assert.equal(port.opens.length, 0);
    assert.equal(port.writes.length, 0);
    assert.equal(port.closes, 0);
  }
});

test("CRC and absolute packets use Modbus bytes and low-word-first signed positions", () => {
  assert.equal(io.crc16(Array.from(Buffer.from("123456789"))), 0x4b37);
  assert.deepEqual([...absoluteRequest(0x12345678).slice(0, -2)], [1, 16, 0, 22, 0, 2, 4, 0x56, 0x78, 0x12, 0x34]);
  assert.deepEqual([...absoluteRequest(-1).slice(7, 11)], [255, 255, 255, 255]);
  for (const target of [0, -0, 2147483648, -2147483649, 1.5, NaN]) assert.throws(() => absoluteRequest(target), TransportError);
  assert.throws(() => configRequest(20, 1), /Unsupported/);
  assert.throws(() => configRequest(1, 89), /Unsupported/);
  assert.throws(() => outputRequest("step"), /Unsupported/);
  assert.equal(configRequest(24, 89)[5], 89);
});

test("snapshot parser decodes both signed words and rejects CRC, length and exception", () => {
  const values = Array(26).fill(0);
  values[22] = 65534; values[23] = 65535; values[12] = 0; values[13] = 32768;
  const parsed = parseSnapshot(snapshot(values));
  assert.deepEqual(parsed, values);
  assert.equal(signedPosition(parsed), -2);
  assert.equal(pending(parsed), -2147483648);
  const badCRC = snapshot(); badCRC[5] = 1;
  assert.throws(() => parseSnapshot(badCRC), /CRC/);
  assert.throws(() => parseSnapshot(snapshot().slice(1)), /CRC|length/);
  assert.throws(() => parseSnapshot(frame([1, 0x83, 2])), error => error.code === 2);
  assert.throws(() => parseSnapshot(frame([2, 0x83, 2])), /slave/);
});

test("streaming guard reads validate fixed ranges and assemble short replies", async () => {
  const port = new FakePort((tx, port) => {
    const start = tx[3], count = tx[5];
    const reply = frame([1, 3, count * 2, ...Array.from({length: count}, (_, i) => [0, start + i]).flat()]);
    port.emit(reply.slice(0, 4)); port.emit(reply.slice(4));
  });
  const connection = new WebSerialConnection(port); await connection.open();
  const registers = [];
  for (const [start, count] of [[0, 7], [7, 7], [14, 7], [21, 5]]) {
    const reply = await connection.exchange(io.statusRequest(start, count));
    assert.equal(reply.length, 5 + 2 * count);
    registers.push(...io.parseStatus(reply, count));
    assert.throws(() => io.parseStatus(reply, count === 7 ? 5 : 7), /length|count/);
  }
  assert.deepEqual(registers, Array.from({length: 26}, (_, i) => i));
  for (const range of [[0, 8], [1, 7], [21, 7], [0, 0], [-1, 7], ["0", 7]]) {
    assert.throws(() => io.statusRequest(...range), /fixed/);
    if (range.every(v => Number.isInteger(v) && v >= 0 && v <= 255)) {
      await assert.rejects(connection.exchange(frame([1, 3, 0, range[0], 0, range[1]])), /protocol|byte|fixed/);
    }
  }
  assert.equal(port.writes.length, 4);
  await connection.close();
});

test("partial status count and CRC errors are rejected without retransmission", async () => {
  for (const corrupt of ["count", "crc"]) {
    const port = new FakePort((tx, port) => {
      const reply = frame([1, 3, corrupt === "count" ? 10 : 14, ...Array(14).fill(0)]);
      if (corrupt === "crc") reply[4] = 1;
      port.emit(reply);
    });
    const connection = new WebSerialConnection(port); await connection.open();
    await assert.rejects(connection.exchange(io.statusRequest(0, 7)), /byte count|CRC/);
    assert.equal(port.writes.length, 1);
    await connection.close();
  }
});

test("Stop intent is checked after the quiet gap before submitting a native write", async () => {
  const port = new FakePort(), connection = new WebSerialConnection(port);
  await connection.open(); let stopped = false, checked = 0;
  const pending = connection.exchange(io.fastPositionRequest(123), .2, () => {
    checked++;
    if (stopped) throw new TransportError("Operation cancelled by Stop.");
  });
  stopped = true;
  await assert.rejects(pending, /cancelled/);
  assert.equal(checked, 1);
  assert.equal(port.writes.length, 0);
  await connection.exchange(outputRequest("inhibit"));
  assert.equal(port.writes.length, 1, "cancelled intent leaves independent inhibit available");
  await connection.close();
});

test("fragmented response chunks assemble without repeating a request", async () => {
  const response = snapshot();
  const port = new FakePort(async (_, port) => {
    for (let index = 0; index < response.length; index += 2) { port.emit(response.slice(index, index + 2)); await sleep(1); }
  });
  const connection = new WebSerialConnection(port); await connection.open();
  assert.deepEqual(await connection.exchange(snapshotRequest(), .2), response);
  assert.equal(port.writes.length, 1);
  await connection.close();
});

test("concurrent exchanges are serialized through response completion", async () => {
  let inFlight = 0, maximum = 0;
  const port = new FakePort(async (tx, port) => {
    maximum = Math.max(maximum, ++inFlight);
    await sleep(12);
    port.emit(ack(tx));
    inFlight--;
  });
  const connection = new WebSerialConnection(port); await connection.open();
  await Promise.all([connection.exchange(configRequest(2, 7)), connection.exchange(configRequest(3, 15))]);
  assert.equal(maximum, 1);
  assert.deepEqual(port.writes.map(tx => tx[3]), [2, 3]);
  await connection.close();
});

test("ACK validation checks FC16 address/count and configuration value", async () => {
  for (const request of [absoluteRequest(123), outputRequest("clear"), configRequest(2, 7)]) {
    const port = new FakePort((tx, port) => { const body = [...tx.slice(0, 6)]; body[5] ^= 1; port.emit(frame(body)); });
    const connection = new WebSerialConnection(port); await connection.open();
    await assert.rejects(connection.exchange(request), /Acknowledgement/);
    assert.equal(port.writes.length, 1);
    await connection.close();
  }
});

test("output ACK leaves pre-update status compatibility to the transport", async () => {
  const port = new FakePort((tx, port) => port.emit(frame([...tx.slice(0, 4), 0, 6])));
  const connection = new WebSerialConnection(port); await connection.open();
  const response = await connection.exchange(outputRequest("inhibit"));
  assert.equal(response[5], 6);
  await connection.close();
});

test("extra response bytes are rejected instead of accepting a valid frame prefix", async () => {
  const port = new FakePort((tx, port) => port.emit([...ack(tx), 99]));
  const connection = new WebSerialConnection(port); await connection.open();
  await assert.rejects(connection.exchange(configRequest(2, 7)), /trailing/);
  assert.equal(port.writes.length, 1);
  await connection.close();
});

test("CRC and exception failures still permit independent cleanup writes", async () => {
  for (const malformed of ["crc", "exception"]) {
    const port = new FakePort((tx, port) => {
      if (port.writes.length === 1) {
        if (malformed === "exception") port.emit(frame([1, 0x83, 4]));
        else { const response = snapshot(); response[56] ^= 1; port.emit(response); }
      } else port.emit(ack(tx));
    });
    const connection = new WebSerialConnection(port); await connection.open();
    await assert.rejects(connection.exchange(snapshotRequest()), /CRC|exception/);
    await connection.exchange(outputRequest("clear"));
    await connection.exchange(outputRequest("inhibit"));
    assert.equal(connection.poisoned, false);
    assert.equal(port.writes.length, 3);
    await connection.close();
  }
});

test("response timeout permits one later clear and inhibit, without automatic retry", async () => {
  const port = new FakePort((tx, port) => { if (port.writes.length > 1) port.emit(ack(tx)); });
  const connection = new WebSerialConnection(port); await connection.open();
  await assert.rejects(connection.exchange(snapshotRequest(), .015), /Response timeout/);
  assert.equal(port.writes.length, 1);
  await connection.exchange(outputRequest("clear"));
  await connection.exchange(outputRequest("inhibit"));
  assert.deepEqual(port.writes.map(tx => [tx[1], tx[3]]), [[3, 0], [16, 12], [6, 1]]);
  await connection.close();
});

test("wrong-function reply is discarded through its deadline before independent inhibit", async () => {
  const oldAck = ack(configRequest(0, 0));
  let tailSent = false;
  const port = new FakePort((tx, port) => {
    if (port.writes.length === 1) {
      port.emit(oldAck.slice(0, 3));
      setTimeout(() => { tailSent = true; port.emit(oldAck.slice(3)); }, 25);
    } else {
      assert.equal(tailSent, true, "cleanup must not race the delayed reply tail");
      port.emit(tx[1] === 3 ? snapshot() : ack(tx));
    }
  });
  const connection = new WebSerialConnection(port); await connection.open();
  await assert.rejects(connection.exchange(outputRequest("clear"), .05), /Response function mismatch/);
  await connection.exchange(outputRequest("inhibit"));
  assert.deepEqual(await connection.exchange(snapshotRequest()), snapshot());
  assert.deepEqual(port.writes.map(tx => [tx[1], tx[3]]), [[16, 12], [6, 1], [3, 0]]);
  assert.equal(connection.poisoned, false);
  await connection.close();
});

test("timed-out reply fragments arriving during recovery do not corrupt cleanup", async () => {
  const response = snapshot();
  const port = new FakePort((tx, port) => {
    if (port.writes.length === 1) {
      port.emit(response.slice(0, 3));
      setTimeout(() => port.emit(response.slice(3, 25)), 20);
      setTimeout(() => port.emit(response.slice(25)), 26);
    } else port.emit(ack(tx));
  });
  const connection = new WebSerialConnection(port); await connection.open();
  await assert.rejects(connection.exchange(snapshotRequest(), .015), /Response timeout/);
  await connection.exchange(outputRequest("inhibit"));
  assert.deepEqual(port.writes.map(tx => [tx[1], tx[3]]), [[3, 0], [6, 1]]);
  assert.equal(connection._buffer.length, 0);
  await connection.close();
});

test("continuous response noise bounds recovery and prevents another write", async () => {
  const noise = [];
  const port = new FakePort((_, port) => {
    port.emit([1, 6, 0]);
    noise.push(setInterval(() => port.emit([99]), 2));
  });
  const connection = new WebSerialConnection(port); await connection.open();
  try {
    await assert.rejects(connection.exchange(snapshotRequest(), .015), /Response function mismatch/);
    const start = performance.now();
    await assert.rejects(connection.exchange(outputRequest("inhibit")), /did not become quiet.*no new request/);
    assert.ok(performance.now() - start < 500, "resynchronization must be bounded");
    assert.equal(port.writes.length, 1);
    assert.equal(connection.poisoned, false);
  } finally {
    for (const interval of noise) clearInterval(interval);
    await connection.close();
  }
});

test("read and write share the same response deadline", async () => {
  const port = new FakePort(async (tx, port) => {
    await sleep(45);
    setTimeout(() => { try { port.emit(ack(tx)); } catch (_) {} }, 45);
  });
  const connection = new WebSerialConnection(port); await connection.open();
  const start = performance.now();
  await assert.rejects(connection.exchange(configRequest(2, 7), .07), /Response timeout/);
  assert.ok(performance.now() - start < 105);
  assert.equal(connection.poisoned, false);
  await connection.close();
});

test("unsettled write quarantines queued commands and reports incomplete cleanup", async () => {
  let finishWrite;
  const port = new FakePort(() => new Promise(resolve => { finishWrite = resolve; }));
  const connection = new WebSerialConnection(port); await connection.open();
  const results = await Promise.allSettled([
    connection.exchange(configRequest(2, 7), .015),
    connection.exchange(outputRequest("inhibit")),
  ]);
  assert.equal(results[0].status, "rejected");
  assert.match(results[0].reason.message, /Write timeout.*cleanup did not settle/);
  assert.equal(results[1].status, "rejected");
  assert.equal(connection.poisoned, true);
  assert.equal(connection.closeIncomplete, true);
  assert.equal(port.writes.length, 1);
  await assert.rejects(connection.exchange(outputRequest("clear")), /unconfirmed/);
  await assert.rejects(connection.close(), /cleanup did not settle/);
  finishWrite();
  await sleep(10);
  assert.equal(port.closes, 1);
  assert.equal(port.writable.locked, false);
  assert.equal(port.writes.length, 1);
});

test("unsupported and malformed requests are rejected before any write", async () => {
  const port = new FakePort(), connection = new WebSerialConnection(port); await connection.open();
  for (const tx of [frame([0, 3, 0, 0, 0, 26]), frame([1, 6, 0, 20, 0, 1]), frame([1, 16, 0, 22, 0, 2, 4, 0, 0, 0, 0])]) {
    await assert.rejects(connection.exchange(tx), TransportError);
  }
  assert.equal(port.writes.length, 0);
  await connection.close();
});

 test("opening drains old adapter bytes and the next request drains late inter-frame noise", async () => {
  const port = new FakePort();
  port.emit([255, 1, 3]);
  const connection = new WebSerialConnection(port);
  await connection.open();
  assert.equal(port.writes.length, 0);
  await connection.exchange(snapshotRequest());
  port.emit([255]);
  await connection.exchange(snapshotRequest());
  assert.equal(port.writes.length, 2);
  await connection.close();
});

test("missing response is recoverable, but the request is not resent automatically", async () => {
 const port=new FakePort(()=>{}),connection=new WebSerialConnection(port);await connection.open();
 await assert.rejects(connection.exchange(absoluteRequest(100),.02),e=>e.recoverableResponse===true);
 assert.equal(port.writes.length,1);await connection.close();
});


test("dedicated absolute position request uses signed big-endian target", () => {
 const io=require("../virtual_synth/static/web-serial-io.js");
 assert.deepEqual(Array.from(io.fastPositionRequest(-1).slice(0,6)),[1,123,255,255,255,255]);
 assert.throws(()=>io.fastPositionRequest(0));
 assert.throws(()=>io.fastPositionRequest(2**31));
});


test("dedicated position exchange accepts encoder feedback instead of a target echo and rejects corrupt replies", async () => {
 for (const corrupt of [false,true]) {
  const reply=frame([1,123,0x12,0x34,0xff,0xff]);
  if(corrupt) reply[7]^=1;
  const port=new FakePort((_,p)=>p.emit(reply)), c=new WebSerialConnection(port);
  await c.open();
  if(corrupt) await assert.rejects(c.exchange(io.fastPositionRequest(1000),.2), /CRC/);
  else assert.deepEqual(await c.exchange(io.fastPositionRequest(1000),.2),reply);
  await c.close();
 }
});
