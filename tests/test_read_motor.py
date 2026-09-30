# SPDX-License-Identifier: MPL-2.0
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Offline protocol tests. No serial devices or pyserial are used."""

import unittest

from virtual_synth.protocol import read_motor as motor


def with_crc(body):
    return body + motor.crc16(body).to_bytes(2, "little")


def snapshot_frame(registers=None, slave=1):
    if registers is None:
        registers = list(range(motor.REGISTER_COUNT))
    return with_crc(bytes((slave, 3, len(registers) * 2)) +
                    b"".join(value.to_bytes(2, "big") for value in registers))


class FakeSerial:
    def __init__(self, incoming, fragment_size=100, short_write=False):
        self.incoming = bytearray(incoming)
        self.fragment_size = fragment_size
        self.short_write = short_write
        self.writes = []
        self.requested_reads = []
        self.timeout = None
        self.write_timeout = None

    def write(self, data):
        self.writes.append(data)
        return len(data) - int(self.short_write)

    def read(self, count):
        self.requested_reads.append(count)
        amount = min(count, self.fragment_size, len(self.incoming))
        data = bytes(self.incoming[:amount])
        del self.incoming[:amount]
        return data


class ProtocolTests(unittest.TestCase):
    def test_manual_known_crc_request_and_response(self):
        # Manual physical page 13: read register 0, return value 1.
        request = bytes.fromhex("01 03 00 00 00 01 84 0A")
        self.assertEqual(motor.crc16(request[:-2]).to_bytes(2, "little"), request[-2:])
        response = bytes.fromhex("01 03 02 00 01 79 84")
        self.assertEqual(motor.parse_response(response, expected_count=1), [1])
        # Manual physical page 17: read the absolute-position pair.
        position_read = bytes.fromhex("01 03 00 16 00 02 25 CF")
        self.assertEqual(motor.crc16(position_read[:-2]).to_bytes(2, "little"), position_read[-2:])

    def test_only_snapshot_read_request_is_constructed(self):
        for slave in (1, 247):
            request = motor.snapshot_request(slave)
            self.assertEqual(request[:6], bytes((slave, 3, 0, 0, 0, 26)))
            self.assertEqual(len(request), 8)
            self.assertEqual(motor.crc16(request[:-2]), int.from_bytes(request[-2:], "little"))
        for slave in (0, -1, 248, 255, True):
            with self.subTest(slave=slave), self.assertRaises(ValueError):
                motor.snapshot_request(slave)

    def test_full_snapshot_and_signed_low_word_first_position(self):
        registers = list(range(26))
        registers[0x16], registers[0x17] = 0xF060, 0xFFFF
        decoded = motor.parse_response(snapshot_frame(registers))
        self.assertEqual(decoded, registers)
        self.assertEqual(motor.signed_position(decoded), -4000)
        registers[0x16], registers[0x17] = 0x5678, 0x1234
        self.assertEqual(motor.signed_position(registers), 0x12345678)

    def test_rejects_corrupt_truncated_and_trailing_frames(self):
        frame = snapshot_frame()
        corrupt = bytearray(frame)
        corrupt[5] ^= 1
        for bad in (bytes(corrupt), frame[:-1], frame[:3], frame + b"\x00"):
            with self.subTest(length=len(bad)), self.assertRaises(motor.ProtocolError):
                motor.parse_response(bad)

    def test_rejects_valid_crc_wrong_slave_function_and_count(self):
        for frame in (snapshot_frame(slave=2),
                      with_crc(bytes((1, 4, 52)) + bytes(52)),
                      snapshot_frame([0] * 25)):
            with self.assertRaises(motor.ProtocolError):
                motor.parse_response(frame)

    def test_exception_response(self):
        with self.assertRaises(motor.ModbusException) as result:
            motor.parse_response(with_crc(bytes((1, 0x83, 2))))
        self.assertEqual(result.exception.code, 2)

    def test_fragmented_response_sends_exactly_one_request(self):
        connection = FakeSerial(snapshot_frame(), fragment_size=1)
        self.assertEqual(motor.read_snapshot(connection), list(range(26)))
        self.assertEqual(connection.writes, [motor.snapshot_request()])
        self.assertLessEqual(max(connection.requested_reads), 54)

    def test_transaction_errors_never_retry(self):
        incoming_frames = (
            b"", snapshot_frame()[:-2], snapshot_frame(slave=2),
            with_crc(bytes((1, 0x83, 2))), bytes((1, 3, 255)), bytes((1, 6, 52)),
        )
        for incoming in incoming_frames:
            connection = FakeSerial(incoming)
            with self.subTest(incoming=incoming[:3]), self.assertRaises(motor.ProtocolError):
                motor.read_snapshot(connection)
            self.assertEqual(connection.writes, [motor.snapshot_request()])
            self.assertLessEqual(max(connection.requested_reads), 54)

    def test_short_write_is_not_retried(self):
        connection = FakeSerial(snapshot_frame(), short_write=True)
        with self.assertRaises(motor.ProtocolError):
            motor.read_snapshot(connection)
        self.assertEqual(len(connection.writes), 1)
        self.assertEqual(connection.requested_reads, [])

    def test_invalid_timeout_never_transmits(self):
        for timeout in (0, -1, 11, float("inf"), float("nan")):
            connection = FakeSerial(snapshot_frame())
            with self.subTest(timeout=timeout), self.assertRaises(ValueError):
                motor.read_snapshot(connection, timeout=timeout)
            self.assertEqual(connection.writes, [])


if __name__ == "__main__":
    unittest.main()
