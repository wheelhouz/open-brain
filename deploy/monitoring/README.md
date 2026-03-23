# Open Brain — Monitoring Stack

## Overview

Three services run in the `brain-net` Docker network alongside the app:

| Service       | Local port | Purpose                          |
|---------------|------------|----------------------------------|
| Prometheus    | (internal) | Metric collection & storage      |
| Grafana       | 3001       | Dashboards & alerting            |
| Uptime Kuma   | 3002       | Uptime / status-page monitoring  |

## Prerequisites

The external Docker network `brain-net` must exist before starting this stack.
It is created automatically by the main `docker-compose.yml`, so start that
stack first.

A `GRAFANA_PASSWORD` environment variable (or `.env` file in this directory)
is required:

```
GRAFANA_PASSWORD=changeme
```

## Start the stack

```bash
cd deploy/monitoring
docker compose up -d
```

## Grafana

Open <http://localhost:3001> and log in with `admin` / `$GRAFANA_PASSWORD`.

The **Open Brain** dashboard is provisioned automatically from
`dashboards/open-brain.json`. The Prometheus datasource is provisioned from
`provisioning/datasources/prometheus.yml`.

## Uptime Kuma setup

1. Open <http://localhost:3002> and create an admin account on first run.
2. Add a new monitor:
   - **Type**: HTTP(s)
   - **Friendly name**: Open Brain health
   - **URL**: `http://open-brain-app:8420/health`
   - **Heartbeat interval**: 60 seconds
3. (Optional) Add a notification channel:
   - Go to **Settings → Notifications**.
   - Choose **Telegram** or **Discord** and follow the on-screen prompts.
   - Attach the notification to the monitor created above.

## Prometheus scrape target

The app exposes Prometheus metrics at `GET /metrics` (no auth required inside
the Docker network). Prometheus scrapes `open-brain-app:8420` every 15 s as
configured in `prometheus.yml`.

## Key metric names

| Metric | Description |
|--------|-------------|
| `open_brain_http_requests_total` | HTTP requests by method/route/status |
| `open_brain_http_duration_ms` | HTTP latency histogram |
| `open_brain_captures_total` | Thought captures by status/source |
| `open_brain_openrouter_calls_total` | OpenRouter calls by operation/model/status |
| `open_brain_openrouter_latency_ms` | OpenRouter latency histogram |
| `open_brain_tokens_total` | Token usage by operation/model/type |
| `open_brain_spend_month_to_date_usd` | Month-to-date AI spend gauge |
| `open_brain_budget_cutoff_total` | Budget cutoff events |
| `open_brain_mcp_tool_calls_total` | MCP tool calls by tool/status |
| `open_brain_mcp_tool_duration_ms` | MCP tool latency histogram |
| `open_brain_mcp_active_sessions` | Active MCP sessions gauge |
| `open_brain_mcp_sessions_created_total` | MCP sessions created |
| `open_brain_facts_total` | Fact operations by outcome |
| `open_brain_entity_resolutions_total` | Entity resolutions by state |
| `open_brain_queue_jobs_total` | Queue jobs by status |
| `open_brain_queue_pending_jobs` | Pending queue jobs gauge |
| `open_brain_db_pool_total` | DB pool total connections |
| `open_brain_db_pool_idle` | DB pool idle connections |
| `open_brain_db_pool_waiting` | DB pool waiting connections |
