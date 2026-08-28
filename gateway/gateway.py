#!/usr/bin/env python3

import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

OPENSEARCH_URL = "http://localhost:9200"
PORT = 8080


class GatewayHandler(BaseHTTPRequestHandler):

    def do_POST(self):
        if self.path != "/logs/search":
            self.send_json(404, {"error": "not found"})
            return

        tenant = self.headers.get("X-Tenant-ID")

        if not tenant:
            self.send_json(401, {"error": "missing X-Tenant-ID"})
            return

        try:
            content_length = int(self.headers.get("Content-Length", 0))
            raw_body = self.rfile.read(content_length)
            client_body = json.loads(raw_body)
        except (ValueError, json.JSONDecodeError):
            self.send_json(400, {"error": "invalid JSON"})
            return

        client_query = client_body.get("query", {"match_all": {}})

        enforced_query = {
            "query": {
                "bool": {
                    "must": [
                        client_query,
                        {
                            "term": {
                                "tenant_id.keyword": tenant
                            }
                        }
                    ]
                }
            }
        }

        body = json.dumps(enforced_query).encode("utf-8")

        request = Request(
            f"{OPENSEARCH_URL}/tenant-test/_search",
            data=body,
            method="POST",
            headers={"Content-Type": "application/json"},
        )

        try:
            with urlopen(request, timeout=5) as response:
                result = response.read()

            self.send_json(200, json.loads(result))

        except HTTPError as e:
            self.send_json(
                502,
                {
                    "error": "OpenSearch returned an error",
                    "status": e.code,
                },
            )

        except URLError as e:
            self.send_json(
                502,
                {
                    "error": "Cannot reach OpenSearch",
                    "detail": str(e.reason),
                },
            )

    def send_json(self, status, data):
        payload = json.dumps(data, indent=2).encode("utf-8")

        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()

        self.wfile.write(payload)


if __name__ == "__main__":
    server = HTTPServer(("0.0.0.0", PORT), GatewayHandler)

    print(f"Gateway listening on :{PORT}")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nGateway stopped")
        server.server_close()
