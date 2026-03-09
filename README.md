# auth-blackroad-io

Part of the [BlackRoad OS](https://blackroad.io) ecosystem.

## Overview

auth-blackroad-io is a Cloudflare Workers-based authentication service with an **Autonomous Agent System** that monitors, maintains, and ensures cohesiveness across all BlackRoad repositories.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Cloudflare Workers Edge                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────────┐    ┌──────────────────┐                   │
│  │  Hono Router     │───▶│  API Endpoints   │                   │
│  └──────────────────┘    └──────────────────┘                   │
│           │                                                      │
│           ▼                                                      │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │              Durable Objects (Stateful Agents)          │    │
│  │                                                          │    │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐  │    │
│  │  │ Autonomous  │  │    Repo     │  │    Cohesion     │  │    │
│  │  │   Agent     │  │   Monitor   │  │    Checker      │  │    │
│  │  └─────────────┘  └─────────────┘  └─────────────────┘  │    │
│  │                                                          │    │
│  │  ┌─────────────────────────────────────────────────────┐│    │
│  │  │              Self-Resolver                          ││    │
│  │  │  (Auto-healing, Circuit Breaker, Issue Creation)    ││    │
│  │  └─────────────────────────────────────────────────────┘│    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │  KV Store   │  │  R2 Bucket  │  │  D1 SQLite  │              │
│  │ Agent State │  │  Snapshots  │  │   History   │              │
│  └─────────────┘  └─────────────┘  └─────────────┘              │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                    Queues                                │    │
│  │  blackroad-agent-tasks (async task processing)          │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

## Autonomous Agents

### 1. Autonomous Agent (Orchestrator)
- Primary coordinator for all agent activities
- Handles webhooks from GitHub
- Routes tasks to appropriate specialized agents
- Performs health checks and orchestration

### 2. Repo Monitor
- Scrapes and tracks all BlackRoad repositories
- Detects missing workflows, outdated configs
- Creates snapshots for historical analysis
- Syncs repo metadata hourly

### 3. Cohesion Checker
- Ensures consistency across all repos
- Validates brand compliance (colors, naming)
- Checks workflow consistency
- Analyzes documentation quality
- Generates cohesion scores and reports

### 4. Self-Resolver
- Automatically fixes issues when possible
- Creates PRs for config updates
- Opens issues for manual review when needed
- Implements circuit breaker pattern
- Maintains resolution history

## Scheduled Tasks

| Cron | Frequency | Task |
|------|-----------|------|
| `*/15 * * * *` | Every 15 min | Agent heartbeat & quick checks |
| `0 * * * *` | Every hour | Full repo sync |
| `0 */6 * * *` | Every 6 hours | Deep cohesion analysis |
| `0 0 * * *` | Daily | Self-resolution review |

## API Endpoints

```
GET  /                          - Health check
GET  /api/agents/status         - All agent statuses
POST /api/agents/scan           - Trigger manual repo scan
GET  /api/cohesion/report       - Get latest cohesion report
POST /api/cohesion/check        - Trigger cohesion check
GET  /api/resolution/history    - Resolution action history
POST /api/resolution/trigger    - Manually trigger resolution
POST /api/tasks/queue           - Queue a task
POST /api/webhooks/github       - GitHub webhook endpoint
```

## Local Development

```bash
# Install dependencies
npm install

# Run locally with Wrangler
npm run dev

# Type check
npm run typecheck

# Run tests
npm test

# Deploy
npm run deploy
```

## Configuration

### Required Secrets (set in Cloudflare Dashboard)

```bash
# GitHub access for repo operations
wrangler secret put GITHUB_TOKEN

# Optional: GitHub App credentials
wrangler secret put GITHUB_APP_ID
wrangler secret put GITHUB_PRIVATE_KEY
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `ENVIRONMENT` | production/staging/development | production |
| `AUTO_RESOLVE_ENABLED` | Enable automatic issue resolution | true |
| `COHESION_CHECK_INTERVAL` | Seconds between checks | 3600 |

## Self-Resolution Features

The Self-Resolver implements several patterns to ensure reliability:

- **Circuit Breaker**: Opens after 5 consecutive failures, resets after 5 minutes
- **Retry Logic**: Tasks retry up to 3 times with exponential backoff
- **Issue Creation**: Creates GitHub issues for failures needing manual intervention
- **Daily Review**: Generates daily reports with patterns and recommendations
- **Rollback Support**: Can rollback previously executed actions

## Brand Compliance

The Cohesion Checker validates against official BlackRoad colors:

```
Hot Pink:     #FF1D6C
Amber:        #F5A623
Electric Blue: #2979FF
Violet:       #9C27B0
Black:        #000000
White:        #FFFFFF
```

## Monitored Repositories

- `blackroad-prism-console`
- `auth-blackroad-io`
- `blackroad-cli`
- `blackroad-sdk`
- `blackroad-docs`

## License

Copyright © 2025 BlackRoad OS, Inc.

## Links

- [BlackRoad OS](https://blackroad.io)
- [Documentation](https://docs.blackroad.io)
- [GitHub](https://github.com/BlackRoad-OS)

---

⬛⬜🛣️ Built with [Claude Code](https://claude.ai/code)
