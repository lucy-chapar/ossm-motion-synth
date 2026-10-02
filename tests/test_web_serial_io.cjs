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

test("construction is inert, open uses only the fixed serial profile, close releases locks", async () => {
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
  let noise;
  const port = new FakePort((_, port) => {
    port.emit([1, 6, 0]);
    noise = setInterval(() => port.emit([99]), 2);
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
    clearInterval(noise);
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
