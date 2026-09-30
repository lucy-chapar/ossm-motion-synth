# SPDX-License-Identifier: MPL-2.0
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Configuration addresses and passive serial tracing used by the bridge.

Extracted from OSSM Synth tools/bench_setup.py. No setup plans or CLI code."""


CONFIG = (0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 20, 21, 24, 25)


class Trace:
    """Capture even a partial/invalid response before propagating an error."""

    def __init__(self, connection, emit):
        self.connection, self.emit, self.received = connection, emit, bytearray()

    @property
    def timeout(self):
        return self.connection.timeout

    @timeout.setter
    def timeout(self, value):
        self.connection.timeout = value

    @property
    def write_timeout(self):
        return self.connection.write_timeout

    @write_timeout.setter
    def write_timeout(self, value):
        self.connection.write_timeout = value

    def write(self, data):
        self.emit({"event": "tx", "hex": data.hex(" ")})
        count = self.connection.write(data)
        if count != len(data):
            self.emit({"event": "partial_write", "bytes_written": count})
        return count

    def read(self, count):
        data = self.connection.read(count)
        self.received.extend(data)
        return data

    def finish(self):
        self.emit({"event": "rx", "hex": self.received.hex(" ")})
