# SPDX-License-Identifier: MPL-2.0
import http.client
import json
import threading
import unittest

from virtual_synth.controller import Controller
from virtual_synth.server import SynthServer


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.controller = Controller()
        self.server = SynthServer(0, self.controller)
        self.thread = threading.Thread(target=self.server.serve_forever,
                                       kwargs={"poll_interval": .01}, daemon=True)
        self.thread.start()
        self.host = f"127.0.0.1:{self.server.server_port}"
        _, data, _ = self.request("GET", "/api/session")
        self.token = json.loads(data)["token"]

    def tearDown(self):
        self.server.shutdown(); self.thread.join(timeout=2)
        self.controller.close(); self.server.server_close()

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=2)
        conn.request(method, path, body=body, headers=headers or {})
        reply = conn.getresponse()
        result = reply.status, reply.read(), dict(reply.getheaders())
        conn.close()
        return result

    def post(self, value, **headers):
        return self.request("POST", "/api/action", json.dumps(value),
                            {"Content-Type":"application/json", "X-Synth-Token":self.token,
                             "Origin":"http://" + self.host, **headers})

    def test_api_state_is_simulation_and_does_not_open_hardware(self):
        status, data, headers = self.request("GET", "/api/state")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(data)["mode"], "simulation")
        self.assertIsNone(self.controller.transport)
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(headers["X-Frame-Options"], "DENY")

    def test_valid_local_control_actions(self):
        self.assertEqual(self.post({"action":"arm"})[0], 200)
        self.assertEqual(self.post({"action":"run"})[0], 200)
        self.assertTrue(self.controller.running)
        self.assertEqual(self.post({"action":"stop"})[0], 200)
        self.assertFalse(self.controller.running)

    def test_csrf_origin_host_fetch_site_and_token_checks(self):
        self.assertEqual(self.post({"action":"arm"}, Origin="https://example.com")[0], 403)
        self.assertEqual(self.post({"action":"arm"}, Host="attacker.example")[0], 403)
        self.assertEqual(self.post({"action":"arm"}, **{"Sec-Fetch-Site":"cross-site"})[0], 403)
        self.assertEqual(self.post({"action":"arm"}, **{"X-Synth-Token":"wrong"})[0], 403)
        self.assertFalse(self.controller.armed)
        status, _, _ = self.request("GET", "/api/session", headers={"Host":"attacker.example"})
        self.assertEqual(status, 403)

    def test_reject_non_json_nonfinite_and_oversize(self):
        self.assertEqual(self.post({"action":"arm"}, **{"Content-Type":"text/plain"})[0], 415)
        self.assertEqual(self.post({"action":"configure", "params":{"rate_hz":float("nan")}})[0], 400)
        self.assertEqual(self.post({"action":"configure", "params":{"x":"a" * 17000}})[0], 400)

    def test_no_arbitrary_files_or_actions(self):
        for path in ("/../README.md", "/static/../../.env", "/api/command"):
            self.assertEqual(self.request("GET", path)[0], 404)
        self.assertEqual(self.post({"action":"write_register", "register":1, "value":1})[0], 400)

    def test_browser_audio_and_help_assets_are_local_scripts(self):
        for path in ("/audio.js", "/tooltips.js"):
            status, body, headers = self.request("GET", path)
            self.assertEqual(status, 200)
            self.assertIn("javascript", headers["Content-Type"])
            self.assertGreater(len(body), 100)
            self.assertIn("script-src 'self'", headers["Content-Security-Policy"])
        self.assertFalse(self.controller.armed)
        self.assertIsNone(self.controller.transport)

    def test_second_tab_cannot_start_first_tabs_armed_session(self):
        self.post({"action":"arm"})
        _, data, _ = self.request("GET", "/api/session")
        other = json.loads(data)["token"]
        self.assertNotEqual(other, self.token)
        self.assertEqual(self.post({"action":"run"}, **{"X-Synth-Token":other})[0], 400)
        self.assertFalse(self.controller.running)
        self.assertEqual(self.post({"action":"stop"}, **{"X-Synth-Token":other})[0], 200)


if __name__ == "__main__": unittest.main()
