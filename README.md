# Cloud Observability Multi-Tenant PoC

## Overview

This project is a from-scratch PoC for a multi-tenant cloud observability system.

The target system collects metrics and logs from a cloud platform, stores metrics in VictoriaMetrics and logs in OpenSearch, and provides visualization through Grafana. Tenant identity and access control are intended to be handled through OIDC/Keycloak and gateway services.

## Target architecture

```text
                         Identity Plane

                     ┌──────────────────┐
                     │     Keycloak     │
                     │ OIDC + tenant    │
                     │ + role           │
                     └────────┬─────────┘
                              │
        ┌─────────────────────┴─────────────────────┐
        │                                           │
        ▼                                           ▼

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
```

## Current PoC architecture

The current sandbox runs all components on one Ubuntu VM:

```text
Host
 ├── metrics ──→ OTel Collector ──→ VictoriaMetrics
 ├── syslog ───→ OTel Collector ──→ OpenSearch
 └── docker log → OTel Collector ──→ OpenSearch

Grafana ──→ VictoriaMetrics
Grafana ──→ OpenSearch

Query Gateway ──→ OpenSearch
```

## Components

| Component | Role | Port |
|---|---|---:|
| Grafana | Dashboard, visualization and query UI | 3000 |
| VictoriaMetrics | Metrics storage and query backend | 8428 |
| OpenSearch | Logs storage and search backend | 9200 |
| OTel Collector | Collect, process and export telemetry | 4317 / 4318 |
| Query Gateway | Prototype tenant enforcement and query proxy | 8080 |

OTel ports 4317/4318 are currently internal container ports in the sandbox; they are not published to the host.

## Implemented

- Host CPU and memory metrics → OTel Collector → VictoriaMetrics
- Linux syslog → OTel Collector → OpenSearch
- Docker container logs → OTel Collector → OpenSearch
- Docker JSON log parsing
- Resource metadata enrichment:
  - `environment=sandbox`
  - `region=lab`
- Grafana → VictoriaMetrics datasource
- Grafana → OpenSearch datasource
- Basic tenant query enforcement prototype
- Shared-index tenant filtering prototype in OpenSearch

## Current status

This is a development/sandbox PoC.

Implemented:

- Basic metrics pipeline
- Basic logs pipeline
- Metrics and logs visualization
- Resource enrichment
- Prototype tenant isolation at query layer

Not implemented yet:

- Keycloak / OIDC authentication
- Production-grade RBAC
- Production-grade ingest gateway
- Production-grade query gateway
- Trusted tenant identity from JWT claims
- Multi-region deployment
- Benchmarking
- Noisy-neighbor evaluation
- Shared-index vs index-per-tenant benchmark
- Production hardening

## Repository structure

```text
cloud-observability-poc/
├── README.md
├── .gitignore
├── otel/
│   └── config.yaml
├── gateway/
│   └── gateway.py
└── docs/
    └── runbook.md
```

## Development environment

Current PoC environment:

```text
VMware
└── Ubuntu VM
    └── Docker
        ├── Grafana
        ├── VictoriaMetrics
        ├── OTel Collector
        ├── OpenSearch
        └── Query Gateway prototype
```

The sandbox is intentionally single-node. Production deployment is expected to distribute services across multiple nodes/instances and potentially multiple regions.
