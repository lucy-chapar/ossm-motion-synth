# SPDX-License-Identifier: MPL-2.0
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Bounded Modbus exchanges and fixed output/clear packet helpers.

Extracted from OSSM Synth tools/bench_jog.py. No bench runner or CLI code.
These functions require an existing connection; they never open one."""

import time

from . import bench_setup, read_motor


DEFAULT_STEP = 16


CONFIG = bench_setup.CONFIG


PROFILES = {
    16: {"seconds": 2.0, "target_tolerance": 4, "pending_tolerance": 0,
         "stable_samples": 3, "max_delta": 64},
    128: {"seconds": 5.0, "target_tolerance": 8, "pending_tolerance": 8,
          "stable_samples": 5, "max_delta": 176},
    819: {"seconds": 5.0, "target_tolerance": 16, "pending_tolerance": 16,
          "stable_samples": 5, "max_delta": 867},
}


def profile_for(step_counts):
    if type(step_counts) is not int or step_counts not in PROFILES:
        raise ValueError("Only fixed 16-, 128-, and 819-count bench profiles are permitted")
    return PROFILES[step_counts]


def pending(values):
    value = values[12] | (values[13] << 16)
    return value - (1 << 32) if value & (1 << 31) else value


def request(slave, operation, step_counts=DEFAULT_STEP):
    """Only four operations exist; arbitrary targets/registers are unavailable."""
    read_motor._validate_slave(slave)
    profile_for(step_counts)
    if operation in ("enable", "inhibit"):
        body = bytes((slave, 6, 0, 1, 0, int(operation == "enable")))
    elif operation in ("clear", "step"):
        # FC16 position words are low word first, bytes big-endian within words.
        value = step_counts if operation == "step" else 0
        body = (bytes((slave, 16, 0, 12, 0, 2, 4))
                + (value & 65535).to_bytes(2, "big") + (value >> 16).to_bytes(2, "big"))
    else:
        raise ValueError("Operation outside the fixed bench proof")
    return body + read_motor.crc16(body).to_bytes(2, "little")


def exchange(connection, tx, timeout, emit):
    """One write and one response, with a shared I/O deadline and no retry."""
    trace = bench_setup.Trace(connection, emit)
    time.sleep(0.005)
    deadline = time.monotonic() + timeout
    try:
        trace.write_timeout = timeout
        if trace.write(tx) != len(tx):
            raise read_motor.ProtocolError("Partial transmission; no retry")
        head = read_motor._read_exactly(trace, 3, deadline)
        if head[0] != tx[0]:
            raise read_motor.ProtocolError("Response slave mismatch")
        if head[1] == (tx[1] | 0x80):
            length = 5
        elif head[1] != tx[1]:
            raise read_motor.ProtocolError("Response function mismatch")
        elif tx[1] == 3:
            if head[2] != 52:
                raise read_motor.ProtocolError("Snapshot byte count mismatch")
            length = 57
        else:
            length = 8
        rx = head + read_motor._read_exactly(trace, length - 3, deadline)
        if read_motor.crc16(rx[:-2]) != int.from_bytes(rx[-2:], "little"):
            raise read_motor.ProtocolError("Response CRC mismatch")
        if rx[1] == (tx[1] | 0x80):
            raise read_motor.ModbusException(rx[2])
        return rx
    finally:
        trace.finish()


def snapshot(connection, slave, timeout, emit):
    rx = exchange(connection, read_motor.snapshot_request(slave), timeout, emit)
    values = read_motor.parse_response(rx, slave)
    emit({"event": "snapshot", "registers": values,
          "position_raw": read_motor.signed_position(values), "pending_raw": pending(values)})
    return values


def write(connection, slave, operation, previous_flags, timeout, emit, step_counts=DEFAULT_STEP):
    tx = request(slave, operation, step_counts)
    rx = exchange(connection, tx, timeout, emit)
    if tx[1] == 16:
        if rx[:6] != tx[:6]:
            raise read_motor.ProtocolError("Increment acknowledgement address/count mismatch")
    else:
        if rx[:4] != tx[:4]:
            raise read_motor.ProtocolError("Output acknowledgement address mismatch")
        echoed = int.from_bytes(rx[4:6], "big")
        # Firmware may echo pre-update status or toggle bits0/2 while updating.
        # Only the requested scalar or a compatible status word is accepted;
        # subsequent snapshots, never this acknowledgement, prove the change.
        if echoed != int(operation == "enable") and (echoed ^ previous_flags) & ~5:
            raise read_motor.ProtocolError("Output acknowledgement status/value mismatch")
