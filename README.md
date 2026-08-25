# Cloud Observability Multi-Tenant PoC

## Mục tiêu
PoC observability multi-tenant thu thập Metrics + Logs, có tenant isolation ở ingest và query.

## Baseline hiện tại
- Docker stack: Grafana, OpenSearch, VictoriaMetrics, OpenTelemetry Collector
- End-to-end connectivity hoạt động
- Có context/resource enrichment

```text
                         Identity Plane
                     ┌──────────────────┐
                     │     Keycloak     │
                     │ OIDC + tenant    │
                     │ + role           │
                     └────────┬─────────┘
                              │
         ┌────────────────────┴─────────────────────┐
         │                                          │
         ▼                                          ▼

   INGESTION PLANE                              QUERY PLANE

┌──────────────────┐                       ┌────────────────┐
│ OTel Agent / SDK │                       │    Grafana     │
└────────┬─────────┘                       └───────┬────────┘
         │ OTLP                                    │
         ▼                                         ▼
┌──────────────────────────┐             ┌──────────────────────┐
│ OTel Ingest Gateway      │             │ Observability Query  │
│                          │             │ Gateway              │
│ Authentication           │             │                      │
│ Tenant Resolver          │             │ OIDC AuthN           │
│ Tenant Enforcement       │             │ RBAC                 │
│ Resource Enrichment      │             │ Tenant Enforcement   │
│ Validation               │             │ Query Proxy          │
│ Batch / Queue            │             └─────────┬────────────┘
└───────────┬──────────────┘                       │
            │                                      │
      ┌─────┴───────┐                        ┌─────┴───────┐
      │             │                        │             │
      ▼             ▼                        ▼             ▼
┌─────────────┐ ┌──────────────┐       ┌─────────────┐ ┌──────────────┐
│ Victoria    │ │ OpenSearch   │       │ Victoria    │ │ OpenSearch   │
│ Metrics     │ │ Logs         │       │ Metrics     │ │ Logs         │
│             │ │              │       │ Query       │ │ Query        │
│ native      │ │ tenant index │       └─────────────┘ └──────────────┘
│ tenant      │ │ / DLS        │
└─────────────┘ └──────────────┘

## Tenant flow
1. Agent gửi token + logstore name tới ingest server của region.
2. Ingest server xác thực token.
3. Ingest server tra mapping backend để xác định tenant và destination.
4. Gateway tạo trusted `tenant.id`; không tin `tenant.id` do client tự gửi.
5. Metrics -> VictoriaMetrics; Logs -> OpenSearch data stream/index tương ứng.
6. Query Gateway enforce tenant scope lần nữa trước khi proxy query.

## Repository layout
```text
cloud-observability-poc/
├── README.md
├── docker-compose.yml
├── .env.example
├── .gitignore
├── docs/
├── otel-collector/
├── grafana/
├── opensearch/
├── victoriametrics/
├── gateway/
└── scripts/
```

## Benchmark cần đo
- ingestion throughput
- query p50/p95/p99
- CPU/RAM/storage
- metric cardinality impact
- noisy-neighbor
- OpenSearch shared index/data stream vs index-per-tenant

## Deliverables
- Architecture + tenant/security model
- Metrics + Logs PoC
- Tenant isolation ingest/query
- Grafana user/admin dashboards
- Benchmark report
- Production recommendations
