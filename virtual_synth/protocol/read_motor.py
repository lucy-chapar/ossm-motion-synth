# SPDX-License-Identifier: MPL-2.0
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Frame encoding and decoding for the YZ-AIM register protocol.

Extracted from OSSM Synth tools/read_motor.py. No device-opening or CLI code.
Vendor reference: YZ-AIMManual_v2_55.pdf, physical pages 11-17."""

import math
import time


FIRST_REGISTER = 0x00


REGISTER_COUNT = 0x1A


READ_FUNCTION = 0x03


class ProtocolError(Exception):
    """A response was missing, malformed, or not for this request."""


class ModbusException(ProtocolError):
    """The drive returned a valid Modbus exception response."""

    def __init__(self, code):
        self.code = code
        super().__init__(f"Drive returned Modbus exception 0x{code:02X}")


def crc16(data):
    """Return the Modbus CRC value; transmit its low byte first."""
    crc = 0xFFFF
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc


def _validate_slave(slave):
    if not isinstance(slave, int) or isinstance(slave, bool) or not 1 <= slave <= 247:
        raise ValueError("Slave address must be 1..247; broadcast is prohibited")


def snapshot_request(slave=1):
    """Build the only supported request: FC03, registers 0x00 through 0x19."""
    _validate_slave(slave)
    body = bytes((slave, READ_FUNCTION, 0, FIRST_REGISTER, 0, REGISTER_COUNT))
    return body + crc16(body).to_bytes(2, "little")


def parse_response(frame, slave=1, expected_count=REGISTER_COUNT):
    """Validate a complete FC03 response before returning its register values."""
    _validate_slave(slave)
    if not isinstance(expected_count, int) or not 1 <= expected_count <= REGISTER_COUNT:
        raise ValueError("Expected register count must be 1..26")
    if not 5 <= len(frame) <= 5 + 2 * REGISTER_COUNT:
        raise ProtocolError("Response length is outside the permitted bounds")
    if crc16(frame[:-2]) != int.from_bytes(frame[-2:], "little"):
        raise ProtocolError("Response CRC mismatch")
    if frame[0] != slave:
        raise ProtocolError(f"Wrong slave address: expected {slave}, received {frame[0]}")
    if frame[1] == (READ_FUNCTION | 0x80):
        if len(frame) != 5:
            raise ProtocolError("Invalid exception response length")
        raise ModbusException(frame[2])
    if frame[1] != READ_FUNCTION:
        raise ProtocolError(f"Unexpected function code 0x{frame[1]:02X}")
    expected_bytes = 2 * expected_count
    if frame[2] != expected_bytes:
        raise ProtocolError(f"Wrong byte count: expected {expected_bytes}, received {frame[2]}")
    if len(frame) != expected_bytes + 5:
        raise ProtocolError("Truncated response or unexpected trailing bytes")
    return [int.from_bytes(frame[i:i + 2], "big") for i in range(3, 3 + expected_bytes, 2)]


def signed_position(registers):
    """Decode the current position without assuming its origin or distance scale."""
    value = registers[0x16] | (registers[0x17] << 16)
    return value - (1 << 32) if value & (1 << 31) else value


def _read_exactly(connection, count, deadline):
    result = bytearray()
    while len(result) < count:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ProtocolError("Response timeout; no retry was sent")
        connection.timeout = remaining
        chunk = connection.read(count - len(result))
        if not chunk:
            raise ProtocolError("Truncated response or response timeout; no retry was sent")
        result.extend(chunk)
    return bytes(result)


def read_snapshot(connection, slave=1, timeout=1.0):
    """Send exactly one FC03 request through an already-open serial connection."""
    if not math.isfinite(timeout) or not 0.1 <= timeout <= 10.0:
        raise ValueError("Timeout must be 0.1..10 seconds")
    request = snapshot_request(slave)
    connection.write_timeout = timeout
    # A single write call. Partial writes are errors, never retried.
    if connection.write(request) != len(request):
        raise ProtocolError("Incomplete request transmission; no retry was sent")
    deadline = time.monotonic() + timeout
    header = _read_exactly(connection, 3, deadline)
    if header[0] != slave:
        raise ProtocolError(f"Unexpected slave address {header[0]}; no discovery or retry")
    if header[1] == (READ_FUNCTION | 0x80):
        tail_length = 2
    elif header[1] == READ_FUNCTION:
        if header[2] != 2 * REGISTER_COUNT:
            raise ProtocolError(f"Unexpected byte count {header[2]}; expected {2 * REGISTER_COUNT}")
        tail_length = 2 * REGISTER_COUNT + 2
    else:
        raise ProtocolError(f"Unexpected function code 0x{header[1]:02X}")
    frame = header + _read_exactly(connection, tail_length, deadline)
    return parse_response(frame, slave)
