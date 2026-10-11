import { Injectable } from '@nestjs/common';

import { collectDefaultMetrics, Gauge, Histogram, Registry } from 'prom-client';

/**
 * One Prometheus registry per process (scraped at GET /metrics).
 *
 * Label rule: only low-cardinality values (route TEMPLATE, never the raw
 * URL; never tenant keys, user ids or emails).
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  readonly httpDuration = new Histogram({
    name: 'http_server_request_duration_seconds',
    help: 'HTTP requests handled by control-plane.',
    labelNames: ['method', 'route', 'status_code'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });

  readonly upstreamDuration = new Histogram({
    name: 'mtco_upstream_request_duration_seconds',
    help: 'Calls from control-plane to Keycloak / Grafana.',
    labelNames: ['service', 'outcome'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });

  readonly outboxPending = new Gauge({
    name: 'mtco_outbox_pending_events',
    help: 'Outbox events not processed yet.',
    labelNames: ['target'] as const,
    registers: [this.registry],
  });

  readonly outboxFailing = new Gauge({
    name: 'mtco_outbox_failing_events',
    help: 'Pending outbox events that failed at least 3 times.',
    labelNames: ['target'] as const,
    registers: [this.registry],
  });

  readonly outboxOldest = new Gauge({
    name: 'mtco_outbox_oldest_pending_seconds',
    help: 'Age of the oldest pending outbox event (0 when none).',
    labelNames: ['target'] as const,
    registers: [this.registry],
  });

  readonly supportAccessActive = new Gauge({
    name: 'mtco_support_access_active_grants',
    help: 'Platform-admin support-access grants in effect.',
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }
}
