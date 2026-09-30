// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MotionWebSerialIO = api;
})(globalThis, function () {
  "use strict";

  class TransportError extends Error {
    constructor(message) { super(message); this.name = "TransportError"; }
  }
  function bytes(value) {
    if (!(value instanceof Uint8Array) && !Array.isArray(value)) throw new TransportError("Expected bytes.");
    if ([...value].some(item => !Number.isInteger(item) || item < 0 || item > 255)) throw new TransportError("Invalid byte value.");
    return Uint8Array.from(value);
  }
  function crc16(value) {
    let crc = 0xffff;
    for (const byte of bytes(value)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
    return crc;
  }
  function frame(body) {
    const data = bytes(body), crc = crc16(data);
    return Uint8Array.from([...data, crc & 255, crc >>> 8]);
  }
  function snapshotRequest() { return frame([1, 3, 0, 0, 0, 26]); }
  function validateCRC(data) {
    if (data.length < 5 || crc16(data.slice(0, -2)) !== (data.at(-2) | data.at(-1) << 8)) throw new TransportError("Response CRC mismatch.");
  }
  function exception(data, expectedFunction) {
    if (data[1] === (expectedFunction | 0x80)) {
      if (data.length !== 5) throw new TransportError("Invalid exception response length.");
      const error = new TransportError(`Drive returned Modbus exception 0x${data[2].toString(16).padStart(2, "0")}.`);
      error.code = data[2];
      throw error;
    }
  }
  function parseSnapshot(value) {
    const data = bytes(value);
    if (data.length < 5 || data.length > 57) throw new TransportError("Snapshot response length is invalid.");
    validateCRC(data);
    if (data[0] !== 1) throw new TransportError("Response slave mismatch.");
    exception(data, 3);
    if (data[1] !== 3 || data[2] !== 52 || data.length !== 57) throw new TransportError("Snapshot function, byte count or length mismatch.");
    return Array.from({ length: 26 }, (_, i) => data[3 + i * 2] * 256 + data[4 + i * 2]);
  }
  function signedWords(values, low) {
    if (!values || ![values[low], values[low + 1]].every(value => Number.isInteger(value) && value >= 0 && value <= 65535)) throw new TransportError("Missing or invalid position words.");
    return values[low] | values[low + 1] << 16;
  }
  function signedPosition(values) { return signedWords(values, 22); }
  function pending(values) { return signedWords(values, 12); }
  function absoluteRequest(target) {
    if (!Number.isInteger(target) || target < -2147483648 || target > 2147483647 || target === 0) throw new TransportError("Absolute target must be a nonzero signed 32-bit integer; zero resets coordinates.");
    return frame([1, 16, 0, 22, 0, 2, 4, target >>> 8 & 255, target & 255, target >>> 24 & 255, target >>> 16 & 255]);
  }
  function outputRequest(operation) {
    if (operation === "clear") return frame([1, 16, 0, 12, 0, 2, 4, 0, 0, 0, 0]);
    if (operation === "enable" || operation === "inhibit") return frame([1, 6, 0, 1, 0, operation === "enable" ? 1 : 0]);
    throw new TransportError("Unsupported output operation.");
  }
  const CONFIG_REGISTERS = new Set([0, 2, 3, 9, 10, 24, 25]);
  function configRequest(register, value) {
    if (!CONFIG_REGISTERS.has(register) || !Number.isInteger(value) || value < 0 || value > 65535) throw new TransportError("Unsupported configuration register or value.");
    return frame([1, 6, 0, register, value >>> 8, value & 255]);
  }
  function validateRequest(value) {
    const tx = bytes(value);
    validateCRC(tx);
    if (tx[0] !== 1 || tx[2] !== 0) throw new TransportError("Only fixed slave 1 registers are supported.");
    if (tx[1] === 3 && tx.length === 8 && tx[3] === 0 && tx[4] === 0 && tx[5] === 26) return tx;
    if (tx[1] === 6 && tx.length === 8 && (CONFIG_REGISTERS.has(tx[3]) || (tx[3] === 1 && tx[4] === 0 && tx[5] <= 1))) return tx;
    if (tx[1] === 16 && tx.length === 13 && tx[4] === 0 && tx[5] === 2 && tx[6] === 4) {
      if (tx[3] === 12 && tx.slice(7, 11).every(value => value === 0)) return tx;
      if (tx[3] === 22 && tx.slice(7, 11).some(value => value !== 0)) return tx;
    }
    throw new TransportError("Request outside the supported motor protocol.");
  }
  function validateResponse(tx, rx) {
    validateCRC(rx);
    if (rx[0] !== tx[0]) throw new TransportError("Response slave mismatch.");
    exception(rx, tx[1]);
    if (rx[1] !== tx[1]) throw new TransportError("Response function mismatch.");
    if (tx[1] === 3) { parseSnapshot(rx); return rx; }
    if (rx.length !== 8) throw new TransportError("Acknowledgement length mismatch.");
    // Output acknowledgements may contain pre-update status flags. The caller
    // validates those against the previous snapshot and then verifies readback.
    const comparedBytes = tx[1] === 6 && tx[3] === 1 ? 4 : 6;
    for (let index = 0; index < comparedBytes; index++) {
      if (rx[index] !== tx[index]) throw new TransportError("Acknowledgement address/count/value mismatch.");
    }
    return rx;
  }
  const now = () => performance.now();
  const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  function bounded(promise, milliseconds, message) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new TransportError(message)), Math.max(0, milliseconds)); }),
    ]).finally(() => clearTimeout(timer));
  }

  class WebSerialConnection {
    constructor(port) {
      if (!port || typeof port.open !== "function" || typeof port.close !== "function") throw new TransportError("An explicitly selected serial port is required.");
      this.port = port;
      this.poisoned = false;
      this.closeIncomplete = false;
      this._opened = this._opening = this._closing = false;
      this._reader = this._writer = null;
      this._buffer = [];
      this._resyncAfter = null;
      this._lastReceiveAt = null;
      this._receiveError = null;
      this._wake = null;
      this._queue = Promise.resolve();
      this._queued = 0;
      this._writePromise = null;
      this._pumpPromise = null;
      this._closePromise = null;
    }
    async open() {
      if (this._opened || this._opening || this._closing || this.poisoned) throw new TransportError("Connection cannot be opened in its current state.");
      this._opening = true;
      try {
        await this.port.open({ baudRate: 19200, dataBits: 8, stopBits: 1, parity: "none", flowControl: "none" });
        this._opened = true;
        if (!this.port.readable || !this.port.writable) throw new TransportError("Serial streams are unavailable.");
        this._reader = this.port.readable.getReader();
        this._writer = this.port.writable.getWriter();
        this._pumpPromise = this._pump();
      } catch (error) {
        try { await this.close(); } catch (_) { /* The original opening failure remains visible. */ }
        throw error instanceof TransportError ? error : new TransportError(`Serial open failed: ${error.message || error}`);
      } finally { this._opening = false; }
    }
    async _pump() {
      try {
        while (!this._closing) {
          const { value, done } = await this._reader.read();
          if (done) {
            if (!this._closing) throw new TransportError("Serial input closed.");
            break;
          }
          if (value && value.length) {
            this._buffer.push(...bytes(value));
            this._lastReceiveAt = now();
          }
          if (this._buffer.length > 256) throw new TransportError("Unexpected serial input exceeded the response buffer.");
          this._wake?.();
        }
      } catch (error) {
        this._receiveError = error instanceof TransportError ? error : new TransportError(`Serial read failed: ${error.message || error}`);
      } finally { this._wake?.(); }
    }
    _requireOpen() {
      if (!this._opened || this._closing || this.poisoned) throw new TransportError("Serial connection is closed or write state is unconfirmed.");
    }
    async _readExactly(count, deadline) {
      while (this._buffer.length < count) {
        this._requireOpen();
        if (this._receiveError) throw this._receiveError;
        if (now() >= deadline) throw new TransportError("Response timeout; no retry was sent.");
        try {
          await bounded(new Promise(resolve => { this._wake = resolve; }), deadline - now(), "Response timeout; no retry was sent.");
        } finally { this._wake = null; }
      }
      if (now() >= deadline) throw new TransportError("Response timeout; no retry was sent.");
      return Uint8Array.from(this._buffer.splice(0, count));
    }
    async _resync() {
      if (this._resyncAfter === null) return;
      // A rejected header or a timeout can leave a partial reply in flight.
      // Discard that reply through its original response window, then require
      // silence before allowing an independent cleanup request onto the wire.
      const notBefore = this._resyncAfter;
      const deadline = Math.max(now(), notBefore) + 250;
      let quietSince = Math.max(now(), notBefore);
      while (true) {
        this._requireOpen();
        if (this._receiveError) throw this._receiveError;
        this._buffer.length = 0;
        quietSince = Math.max(quietSince, this._lastReceiveAt ?? quietSince);
        const time = now();
        if (time >= notBefore && time - quietSince >= 10) {
          this._resyncAfter = null;
          return;
        }
        if (time >= deadline) throw new TransportError("Serial input did not become quiet after a response error; no new request was sent.");
        const wakeAt = Math.min(deadline, Math.max(notBefore, quietSince + 10));
        // A timed poll also handles a quiet receive stream without installing
        // another read or changing the sole reader pump's ownership.
        await delay(Math.max(1, Math.min(10, wakeAt - time)));
      }
    }
    async exchange(value, timeoutSeconds = 0.15) {
      const tx = validateRequest(value);
      if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 10) throw new TransportError("Invalid exchange timeout.");
      this._requireOpen();
      if (this._queued >= 8) throw new TransportError("Serial command queue is full.");
      this._queued++;
      const operation = this._queue.then(() => this._exchange(tx, timeoutSeconds));
      this._queue = operation.catch(() => {});
      try { return await operation; } finally { this._queued--; }
    }
    async _exchange(tx, timeoutSeconds) {
      this._requireOpen();
      await delay(5); // Fixed RTU inter-frame gap, as in the Python transport.
      await this._resync();
      this._requireOpen();
      const deadline = now() + timeoutSeconds * 1000;
      let writeSettled = false;
      const write = this._writer.write(tx);
      this._writePromise = write;
      write.then(() => { writeSettled = true; }, () => { writeSettled = true; });
      try {
        await bounded(write, deadline - now(), "Write timeout; transmission and software stop are unconfirmed.");
      } catch (error) {
        if (!writeSettled) {
          // A still-pending native write must never race a later inhibit or be
          // treated as successful cleanup. Permanently quarantine this object.
          this.poisoned = true;
          try { await this.close(); } catch (cleanupError) {
            throw new TransportError(`${error.message} ${cleanupError.message}`);
          }
        }
        throw error instanceof TransportError ? error : new TransportError(`Serial write failed: ${error.message || error}`);
      } finally { if (writeSettled) this._writePromise = null; }
      try {
        const head = await this._readExactly(3, deadline);
        let length;
        if (head[0] !== tx[0]) throw new TransportError("Response slave mismatch.");
        if (head[1] === (tx[1] | 0x80)) length = 5;
        else if (head[1] !== tx[1]) throw new TransportError("Response function mismatch.");
        else if (tx[1] === 3) {
          if (head[2] !== 52) throw new TransportError("Snapshot byte count mismatch.");
          length = 57;
        } else length = 8;
        const tail = await this._readExactly(length - 3, deadline);
        if (this._buffer.length) throw new TransportError("Unexpected trailing response bytes.");
        return validateResponse(tx, Uint8Array.from([...head, ...tail]));
      } catch (error) {
        this._resyncAfter = deadline;
        throw error;
      }
    }
    async close() {
      if (this._closePromise) return this._closePromise;
      this._closing = true;
      this._wake?.();
      this._closePromise = this._finishClose();
      return this._closePromise;
    }
    async _finishClose() {
      const cleanup = async () => {
        const errors = [];
        const settle = async action => { try { await action(); } catch (error) { errors.push(error); } };
        await Promise.all([
          settle(async () => { if (this._reader) await this._reader.cancel(); }),
          settle(async () => { if (this._writer) await this._writer.abort(new TransportError("Serial connection closing.")); }),
        ]);
        if (this._pumpPromise) await settle(() => this._pumpPromise);
        if (this._writePromise) await settle(() => this._writePromise);
        await settle(() => this._reader?.releaseLock());
        await settle(() => this._writer?.releaseLock());
        this._reader = this._writer = null;
        if (this._opened) await settle(() => this.port.close());
        this._opened = false;
        if (errors.length) throw new TransportError(`Serial cleanup reported ${errors.length} error(s); port closure is unconfirmed.`);
      };
      try {
        await bounded(cleanup(), 300, "Serial cleanup did not settle; port closure and stop remain unconfirmed.");
      } catch (error) {
        this.closeIncomplete = true;
        throw error;
      }
    }
  }
  return { WebSerialConnection, TransportError, crc16, frame, snapshotRequest, parseSnapshot, signedPosition, pending, absoluteRequest, outputRequest, configRequest };
});
