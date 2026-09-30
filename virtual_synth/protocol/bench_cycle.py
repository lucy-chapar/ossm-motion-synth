# SPDX-License-Identifier: MPL-2.0
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Nonzero signed absolute-position packet helpers.

Extracted from OSSM Synth tools/bench_cycle.py. No cycle runner or CLI code.
A response failure never retries the target."""

from . import bench_jog, read_motor


def absolute_request(slave, target):
    """FC16 absolute position, low word first; zero is a coordinate-reset command."""
    read_motor._validate_slave(slave)
    if type(target) is not int or not -(1 << 31) <= target < (1 << 31) or target == 0:
        raise ValueError("Absolute destination must be a nonzero signed 32-bit integer")
    encoded = target & 0xFFFFFFFF
    body = (bytes((slave, 16, 0, 22, 0, 2, 4))
            + (encoded & 65535).to_bytes(2, "big") + (encoded >> 16).to_bytes(2, "big"))
    return body + read_motor.crc16(body).to_bytes(2, "little")


def write_absolute(connection, slave, target, timeout, emit):
    tx = absolute_request(slave, target)
    rx = bench_jog.exchange(connection, tx, timeout, emit)
    if rx[:6] != tx[:6]:
        raise read_motor.ProtocolError("Absolute-position acknowledgement address/count mismatch")
