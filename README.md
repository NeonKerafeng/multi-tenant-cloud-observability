# Multi-Tenant Cloud Observability

## Overview

This project is a comprehensive synthesis of my research on the `multi-tenant cloud observability` topic. It presents both a conceptual framework and a practical implementation guide for building such systems.

As a built-from-scratch Proof of Concept (PoC) for a `multi-tenant cloud observability` system, the target system collects metrics and logs from a cloud platform, stores metrics in `VictoriaMetrics` and logs in `OpenSearch`, and provides visualization through `Grafana`. Tenant identity and access control are intended to be handled through `OIDC/Keycloak` and gateway services.

## Architecture

```
                                      INGEST PLANE


                              ┌──────────────────────────┐
                              │       OTel Agent         │
                              │                          │
                              │ Role:                    │
                              │ Telemetry Collector      │
                              │                          │
                              │ - collect metrics        │
                              │ - collect logs           │
                              │ - export OTLP            │
                              └────────────┬─────────────┘
                                           │
                                           │  PUSH — OTLP/HTTP
                                           │
                                           │  Authentication: ❌
                                           │  Authorization:  ❌
                                           │  Tenant-aware:   ❌
                                           │
                                           ▼
                              ┌──────────────────────────┐
                              │    OTel Ingest Gateway   │
                              │                          │
                              │ Role:                    │
                              │ Trusted Ingest Gateway   │
                              │                          │
                              │ - authenticate client    │
                              │ - authorize client       │
                              │ - resolve tenant         │
                              │ - enforce tenant         │
                              │ - enrich telemetry       │
                              │ - batch / route          │
                              └────────────┬─────────────┘
                                           │
                         ┌─────────────────┴─────────────────┐
                         │                                   │
                         │  PUSH — Metrics                   │  PUSH — Logs
                         │                                   │
                         │  Authentication: ❌               │  Authentication: ✅
                         │  Authorization:  ❌               │  Authorization:  ✅
                         │  Tenant-aware:   ✅               │  Tenant-aware:   ✅
                         │                                   │
                         │  Tenant model:                    │  Service identity:
                         │  accountID/projectID              │  otel-ingest
                         │                                   │
                         │                                   │  Role:
                         │                                   │  otel-ingest-role
                         │                                   │
                         ▼                                   ▼
              ┌──────────────────────────┐       ┌──────────────────────────┐
              │    VictoriaMetrics       │       │       OpenSearch         │
              │       Cluster            │       │                          │
              │                          │       │ Role:                    │
              │ Role:                    │       │ Log Storage / Search     │
              │ Metrics Storage          │       │                          │
              │                          │       │ Multi-tenancy:           │
              │ Multi-tenancy: Native    │       │    "shared index"        │
              │                          │       │    + tenant.id           │
              │ accountID/projectID      │       │    + DLS                 │
              │                          │       │                          │
              └──────────────────────────┘       └──────────────────────────┘
```

```
                             QUERY PLANE

         USER SIDE                                 PLATFORM SIDE


┌───────────────────────────┐
│           User            │
└─────────────┬─────────────┘
              │
              │ Login
              │
              │ AuthN: ⏳ planned
              ▼
┌───────────────────────────┐
│         Keycloak          │
│                           │
│     OIDC Identity         │
│   tenant + user + role    │
└─────────────┬─────────────┘
              │
              │ JWT / OIDC token
              ▼
┌───────────────────────────┐
│          Grafana          │
│                           │
│ Visualization / frontend  │
└─────────────┬─────────────┘
              │
              │ QUERY
              │
              ▼
┌──────────────────────────────────────────────┐
│             Observability Query Gateway      │
│                                              │
│  AuthN: validate OIDC token                  │
│  AuthZ: resolve role / tenant                │
│  Tenant enforcement                         │
│  Query routing / proxy                      │
└───────────────────┬──────────────────────────┘
                    │
           ┌────────┴────────┐
           │                 │
           │ QUERY           │ QUERY
           │                 │
           ▼                 ▼
┌──────────────────┐  ┌──────────────────┐
│ VictoriaMetrics  │  │    OpenSearch    │
│                  │  │                  │
│ metrics          │  │ logs             │
└──────────────────┘  └──────────────────┘
         │                    │
         │                    │
 Future tenant model:    Future tenant model:
         │                    │
 accountID/projectID     shared index
 native tenant           + tenant.id
 namespace               + DLS
         │                    │
         ▼                    ▼
      Tenant A              Tenant A
      Tenant B              Tenant B
      Tenant C              Tenant C
```



```
                    CURRENT DEBUG QUERY PATH

curl
 │
 ├──── GET /api/v1/query ─────────────▶ VictoriaMetrics
 │                                      AuthN: ❌
 │                                      AuthZ: ❌
 │
 └──── HTTPS + admin credential ──────▶ OpenSearch
                                        AuthN: ✅
                                        AuthZ: ✅ admin
```

```
                               MULTI-TENANT INGEST

Tenant A Agent ──┐
Tenant A Agent ──┤
Tenant B Agent ──┤
Tenant C Agent ──┘
                 │
                 │ OTLP
                 │
                 │ AuthN:
                 │ prove client identity
                 │
                 │ AuthZ:
                 │ determine allowed tenant
                 │
                 ▼
        ┌───────────────────────┐
        │   Ingest Gateway      │
        │                       │
        │ authenticate          │
        │ authorize             │
        │ resolve tenant        │
        │ enforce tenant        │
        │ enrich telemetry      │
        └───────────┬───────────┘
                    │
             ┌──────┴───────┐
             │              │
             ▼              ▼
      VictoriaMetrics    OpenSearch
          Cluster
             │              │
     accountID/projectID     │ tenant.id
             │              │
        native tenant       shared index
        namespace           + DLS
```