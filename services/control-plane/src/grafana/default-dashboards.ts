/**
 * Dashboards provisioned into every tenant org (TODO-02 step 8).
 * Created only when missing (by uid): a tenant may edit or delete them and
 * control-plane never overwrites their version.
 *
 * Metric names follow the OTel -> Prometheus remote-write translation of
 * the agent's host_metrics receiver. The regex on __name__ accepts both the
 * suffixed (`_seconds_total`, `_bytes`) and unsuffixed spellings.
 */

const PROM = { type: 'prometheus', uid: 'victoriametrics' };
const LOGS = { type: 'grafana-opensearch-datasource', uid: 'opensearch' };

const CPU = '{__name__=~"system_cpu_time(_seconds)?_total", host_name=~"$host"}';
const MEM = '{__name__=~"system_memory_usage(_bytes)?", host_name=~"$host"}';
const LOAD = '{__name__=~"system_cpu_load_average_1m(_ratio)?", host_name=~"$host"}';
const NET = '{__name__=~"system_network_io(_bytes)?_total", host_name=~"$host"}';
const FS = '{__name__=~"system_filesystem_usage(_bytes)?", host_name=~"$host"}';

function withState(selector: string, state: string): string {
  return selector.replace('}', `, state="${state}"}`);
}

function timeseries(
  id: number,
  title: string,
  expr: string,
  legend: string,
  unit: string,
  gridPos: { x: number; y: number; w: number; h: number },
) {
  return {
    id,
    type: 'timeseries',
    title,
    datasource: PROM,
    gridPos,
    fieldConfig: { defaults: { unit }, overrides: [] },
    targets: [{ refId: 'A', datasource: PROM, expr, legendFormat: legend }],
  };
}

export const HOST_OVERVIEW_UID = 'mtco-host-overview';

export function hostOverviewDashboard() {
  return {
    uid: HOST_OVERVIEW_UID,
    title: 'Hosts overview',
    tags: ['mtco', 'default'],
    timezone: 'browser',
    refresh: '30s',
    time: { from: 'now-1h', to: 'now' },
    schemaVersion: 39,
    templating: {
      list: [
        {
          name: 'host',
          label: 'Host',
          type: 'query',
          datasource: PROM,
          query: {
            qryType: 1,
            query: `label_values(${MEM.replace(', host_name=~"$host"', '')}, host_name)`,
            refId: 'host',
          },
          refresh: 2,
          multi: true,
          includeAll: true,
          allValue: '.*',
          sort: 1,
        },
      ],
    },
    panels: [
      timeseries(
        1,
        'CPU used',
        `100 * (1 - sum by (host_name) (rate(${withState(CPU, 'idle')}[$__rate_interval])) / sum by (host_name) (rate(${CPU}[$__rate_interval])))`,
        '{{host_name}}',
        'percent',
        { x: 0, y: 0, w: 12, h: 8 },
      ),
      timeseries(
        2,
        'Memory used',
        `100 * sum by (host_name) (${withState(MEM, 'used')}) / sum by (host_name) (${MEM})`,
        '{{host_name}}',
        'percent',
        { x: 12, y: 0, w: 12, h: 8 },
      ),
      timeseries(
        3,
        'Load average (1m)',
        LOAD,
        '{{host_name}}',
        'short',
        { x: 0, y: 8, w: 8, h: 8 },
      ),
      timeseries(
        4,
        'Network I/O',
        `sum by (host_name, direction) (rate(${NET}[$__rate_interval]))`,
        '{{host_name}} {{direction}}',
        'Bps',
        { x: 8, y: 8, w: 8, h: 8 },
      ),
      timeseries(
        5,
        'Filesystem used',
        `100 * sum by (host_name, mountpoint) (${withState(FS, 'used')}) / sum by (host_name, mountpoint) (${FS})`,
        '{{host_name}} {{mountpoint}}',
        'percent',
        { x: 16, y: 8, w: 8, h: 8 },
      ),
      {
        id: 6,
        type: 'logs',
        title: 'Logs',
        datasource: LOGS,
        gridPos: { x: 0, y: 16, w: 24, h: 10 },
        options: { showTime: true, wrapLogMessage: true, sortOrder: 'Descending' },
        targets: [
          {
            refId: 'A',
            datasource: LOGS,
            queryType: 'lucene',
            luceneQueryType: 'Logs',
            query: '*',
            timeField: '@timestamp',
            metrics: [{ id: '1', type: 'logs' }],
            bucketAggs: [],
          },
        ],
      },
    ],
  };
}

export function defaultDashboards() {
  return [hostOverviewDashboard()];
}
