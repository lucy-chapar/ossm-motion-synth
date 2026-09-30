# SPDX-License-Identifier: MPL-2.0
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Offline motor fixtures extracted from OSSM-Synth; never opens a device."""

from virtual_synth.protocol import read_motor


def frame(body):
    return body + read_motor.crc16(body).to_bytes(2, "little")


class Clock:
    def __init__(self):
        self.elapsed = 0.0

    def now(self):
        return self.elapsed

    def wait(self, seconds):
        self.elapsed += seconds


class Motor:
    def __init__(self, on_read=None, on_command=None):
        self.values = [0] * 26
        self.values[0], self.values[1] = 1, 6
        self.values[2], self.values[3], self.values[11] = 3, 10, 800
        self.values[21], self.values[22] = 1, 2815
        self.writes, self.commands = [], []
        self.incoming = bytearray()
        self.timeout = self.write_timeout = None
        self.read_count = 0
        self.target = None
        self.on_read, self.on_command = on_read, on_command

    def position(self, value):
        self.values[22], self.values[23] = value & 65535, (value >> 16) & 65535

    def remaining(self, value):
        self.values[12], self.values[13] = value & 65535, (value >> 16) & 65535

    def write(self, tx):
        self.writes.append(tx)
        if tx[1] == 3:
            self.read_count += 1
            if self.on_read:
                self.on_read(self)
            rx = frame(bytes((1, 3, 52)) + b"".join(v.to_bytes(2, "big") for v in self.values))
        else:
            previous = self.values[1]
            if tx[1] == 6:
                operation = "enable" if tx[5] else "inhibit"
                self.values[1] = (previous | 1) if tx[5] else (previous & ~1)
                rx = frame(tx[:4] + self.values[1].to_bytes(2, "big"))
            else:
                value = int.from_bytes(tx[7:9], "big") | (int.from_bytes(tx[9:11], "big") << 16)
                operation = "step" if value else "clear"
                self.values[12], self.values[13] = 0, 0
                if value:
                    self.target = read_motor.signed_position(self.values) + value
                    self.position(self.target)
                rx = frame(tx[:6])
            self.commands.append(operation)
            if self.on_command:
                replacement = self.on_command(self, operation, tx, previous)
                if replacement is not None:
                    rx = replacement
        self.incoming.extend(rx)
        return len(tx)

    def read(self, count):
        # Fragmented reads verify frame assembly independently of one read size.
        data = bytes(self.incoming[:min(count, 3)])
        del self.incoming[:len(data)]
        return data


class AbsoluteMotor(Motor):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.values[1] = 0
        self.destinations = []

    def write(self, tx):
        if tx[1] != 16 or tx[3] != 22:
            return super().write(tx)
        self.writes.append(tx)
        target = int.from_bytes(tx[7:9], "big") | (int.from_bytes(tx[9:11], "big") << 16)
        if target & (1 << 31):
            target -= 1 << 32
        self.destinations.append(target)
        self.commands.append("absolute")
        self.target = target
        self.position(target)
        self.remaining(0)
        rx = frame(tx[:6])
        if self.on_command:
            replacement = self.on_command(self, "absolute", tx, self.values[1])
            if replacement is not None:
                rx = replacement
        self.incoming.extend(rx)
        return len(tx)
