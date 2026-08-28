# Cloud Observability PoC — Runbook

## 1. Environment

Current environment:

- VMware Ubuntu VM
- Docker
- One Docker network: `observability`
- Single-node sandbox

The host IP is environment-dependent. Do not hard-code the current VM IP in source code.

## 2. Main ports and URLs

| Port | Service | Purpose |
|---|---|---|
| 3000 | Grafana | Web UI |
| 8428 | VictoriaMetrics | HTTP API and VMUI |
| 9200 | OpenSearch | HTTP API |
| 8080 | Query Gateway | Prototype query API |
| 4317 | OTel Collector | OTLP/gRPC, internal |
| 4318 | OTel Collector | OTLP/HTTP, internal |

Typical URLs:

```text
Grafana:
http://<HOST_IP>:3000

VictoriaMetrics:
http://<HOST_IP>:8428

VictoriaMetrics UI:
http://<HOST_IP>:8428/vmui

OpenSearch:
http://<HOST_IP>:9200

Query Gateway:
http://<HOST_IP>:8080
```

## 3. Docker network

Network:

```text
observability
```

The PoC containers should be attached to the same network.

Because Docker provides DNS for containers on the same user-defined network, services can refer to each other by container name:

```text
http://victoriametrics:8428
http://opensearch:9200
```

Do not use `localhost` between containers. Inside a container, `localhost` means that same container.

## 4. Container lifecycle

Check running containers:

```bash
docker ps
```

Start existing containers:

```bash
docker start grafana victoriametrics otel-collector opensearch
```

Stop containers:

```bash
docker stop grafana victoriametrics otel-collector opensearch
```

Restart a container:

```bash
docker restart otel-collector
```

Read recent logs:

```bash
docker logs --since 5m grafana
docker logs --since 5m otel-collector
docker logs --since 5m opensearch
```

Follow new logs:

```bash
docker logs -f --tail 20 otel-collector
```

Note:

`docker run` creates a new container.

`docker start` starts an existing container.

`docker stop` stops it.

`docker rm` removes the container.

Named volumes are separate from containers and may preserve application data.

## 5. OTel Collector

Config file:

```text
~/observability-lab/otel/config.yaml
```

The config is bind-mounted into the container:

```text
Host:
~/observability-lab/otel/config.yaml

Container:
/etc/otelcol-contrib/config.yaml
```

The host root filesystem is also bind-mounted read-only:

```text
Host:
/

Container:
/hostfs
```

This allows the Collector to read host metrics and host log files.

The current container is created with:

```text
--network observability
--user 0
-v /home/nanashi/observability-lab/otel/config.yaml:/etc/otelcol-contrib/config.yaml:ro
-v /:/hostfs:ro
--restart unless-stopped
```

The `--user 0` setting is used in this sandbox so the Collector can read protected host log files such as `/var/log/syslog`. This is a lab choice, not a production security recommendation.

### OTel pipelines

Metrics:

```text
host_metrics
    ↓
resource processor
    ↓
prometheus_remote_write
    ↓
VictoriaMetrics
```

Logs:

```text
file_log/syslog
        \
         \
          → resource processor → OpenSearch
         /
file_log/grafana
```

Current enrichment:

```text
environment = sandbox
region = lab
```

## 6. Metrics verification

Check that VictoriaMetrics is reachable:

```bash
curl http://localhost:8428
```

Open VMUI:

```text
http://<HOST_IP>:8428/vmui
```

Example query:

```text
{__name__=~"system_memory.*"}
```

Expected result:

Host memory time series produced by the OTel `host_metrics` receiver.

Grafana:

```text
Connections
→ VictoriaMetrics
```

Datasource URL:

```text
http://victoriametrics:8428
```

Example Explore query:

```text
{__name__=~"system_memory.*"}
```

## 7. Host syslog verification

The host log file is:

```text
/var/log/syslog
```

Create a fresh test event:

```bash
logger "OBSERVABILITY_PROBE_001"
```

Verify at the source:

```bash
sudo tail -n 20 /var/log/syslog
```

Expected:

```text
OBSERVABILITY_PROBE_001
```

The OTel receiver reads:

```text
/hostfs/var/log/syslog
```

which maps to the Ubuntu host's:

```text
/var/log/syslog
```

The log is then exported to OpenSearch.

## 8. Docker container log verification

The sandbox containers use Docker's:

```text
json-file
```

logging driver.

Check a container:

```bash
docker inspect grafana \
  --format 'driver={{.HostConfig.LogConfig.Type}} path={{.LogPath}}'
```

Typical path:

```text
/var/lib/docker/containers/<CONTAINER_ID>/<CONTAINER_ID>-json.log
```

Create fresh container logs:

```bash
docker restart grafana
```

The current lab configuration reads the Grafana container log file and parses Docker JSON format.

## 9. OpenSearch verification

Check that OpenSearch is reachable:

```bash
curl http://localhost:9200
```

Cluster health:

```bash
curl "http://localhost:9200/_cluster/health?pretty"
```

List indexes:

```bash
curl "http://localhost:9200/_cat/indices?v"
```

Current lab log index has been:

```text
ss4o_logs-default-namespace
```

Search recent documents:

```bash
curl "http://localhost:9200/ss4o_logs-default-namespace/_search?pretty&size=5"
```

The sandbox uses a single OpenSearch node, so `yellow` can occur when replica shards cannot be assigned to another node.

## 10. Grafana → OpenSearch

Datasource URL:

```text
http://opensearch:9200
```

Typical index:

```text
ss4o_logs-*
```

For the current data, the actual time field used successfully in Grafana is:

```text
observedTimestamp
```

The `@timestamp` field currently may be `1970-01-01` for some syslog data because the raw syslog timestamp has not yet been parsed into the OpenTelemetry log timestamp.

This is a known PoC limitation.

## 11. Tenant isolation prototype

The prototype stores multiple tenants in one OpenSearch index:

```text
tenant-test
├── tenant-A
└── tenant-B
```

Exact tenant filtering uses the `.keyword` field:

```json
{
  "query": {
    "term": {
      "tenant_id.keyword": "tenant-A"
    }
  }
}
```

Reason:

```text
tenant_id
    → text

tenant_id.keyword
    → exact-value field
```

## 12. Tenant isolation prototype

The current prototype uses a shared OpenSearch index:

```text
tenant-test
├── tenant-A
└── tenant-B
```

### Insert Tenant A

```bash
curl -X POST \
  "http://localhost:9200/tenant-test/_doc" \
  -H "Content-Type: application/json" \
  -d '{
    "tenant_id": "tenant-A",
    "service": "payment",
    "level": "ERROR",
    "message": "database timeout from tenant A"
  }'
```

### Insert Tenant B

```bash
curl -X POST \
  "http://localhost:9200/tenant-test/_doc" \
  -H "Content-Type: application/json" \
  -d '{
    "tenant_id": "tenant-B",
    "service": "payment",
    "level": "ERROR",
    "message": "database timeout from tenant B"
  }'
```

### Query Tenant A

```bash
curl -X GET \
  "http://localhost:9200/tenant-test/_search?pretty" \
  -H "Content-Type: application/json" \
  -d '{
    "query": {
      "term": {
        "tenant_id.keyword": "tenant-A"
      }
    }
  }'
```

Expected result:

```text
Only documents belonging to tenant-A
```

### Query Tenant B

```bash
curl -X GET \
  "http://localhost:9200/tenant-test/_search?pretty" \
  -H "Content-Type: application/json" \
  -d '{
    "query": {
      "term": {
        "tenant_id.keyword": "tenant-B"
      }
    }
  }'
```

Expected result:

```text
Only documents belonging to tenant-B
```

### Tenant A through Query Gateway

The prototype Gateway uses:

```text
X-Tenant-ID: tenant-A
```

as a trusted tenant identity for the lab.

```bash
curl -X POST \
  -H "X-Tenant-ID: tenant-A" \
  -H "Content-Type: application/json" \
  -d '{
    "query": {
      "term": {
        "level.keyword": "ERROR"
      }
    }
  }' \
  http://localhost:8080/logs/search
```

Expected result:

```text
Only tenant-A documents
```

### Tenant B through Query Gateway

```bash
curl -X POST \
  -H "X-Tenant-ID: tenant-B" \
  -H "Content-Type: application/json" \
  -d '{
    "query": {
      "term": {
        "level.keyword": "ERROR"
      }
    }
  }' \
  http://localhost:8080/logs/search
```

Expected result:

```text
Only tenant-B documents
```

### Tenant A attempts to access Tenant B

The client belongs to Tenant A but attempts to query Tenant B:

```bash
curl -X POST \
  -H "X-Tenant-ID: tenant-A" \
  -H "Content-Type: application/json" \
  -d '{
    "query": {
      "term": {
        "tenant_id.keyword": "tenant-B"
      }
    }
  }' \
  http://localhost:8080/logs/search
```

Expected result:

```text
0 documents
```

The Gateway combines the client query with the trusted tenant filter:

```text
client query
    AND
tenant_id.keyword = trusted tenant
```

Therefore, a client belonging to Tenant A cannot override the tenant filter by requesting Tenant B.

### Tenant B attempts to access Tenant A

```bash
curl -X POST \
  -H "X-Tenant-ID: tenant-B" \
  -H "Content-Type: application/json" \
  -d '{
    "query": {
      "term": {
        "tenant_id.keyword": "tenant-A"
      }
    }
  }' \
  http://localhost:8080/logs/search
```

Expected result:

```text
0 documents
```

### Verification summary

```text
Direct OpenSearch:

POST tenant-A
POST tenant-B
      ↓
query A → A only
query B → B only


Query Gateway:

X-Tenant-ID: tenant-A
      ↓
query A → A only
query B → 0 results

X-Tenant-ID: tenant-B
      ↓
query B → B only
query A → 0 results
```

> Note: `X-Tenant-ID` is only a lab mechanism. It is not an authentication mechanism. In the target architecture, tenant identity should come from a verified OIDC/JWT identity.


## 13. Verification principle

When debugging the system, verify each edge independently.

```text
Container running
    ↓
Service reachable
    ↓
Source data exists
    ↓
Receiver reads source
    ↓
Exporter reaches backend
    ↓
Backend stores data
    ↓
Grafana queries backend
```

Examples:

```text
OpenSearch:
curl http://localhost:9200

VictoriaMetrics:
VMUI query

Ubuntu → OTel → OpenSearch:
logger "OBSERVABILITY_PROBE_001"
→ search OpenSearch

Ubuntu metrics → OTel → VictoriaMetrics:
{__name__=~"system_memory.*"}

Tenant isolation:
tenant-A request
→ attempt tenant-B query
→ expect 0 results
```

## 14. Important runtime details

Do not commit runtime state to Git:

```text
Docker volumes
OpenSearch data
Grafana data
/var/lib/docker/containers/*
container IDs
host IP addresses
passwords
tokens
.env secrets
```

Runtime details such as container IDs and Docker-assigned IP addresses are expected to change.

The repository should contain configuration and source code needed to reproduce the environment, not the runtime itself.
