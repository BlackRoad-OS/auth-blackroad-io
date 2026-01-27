-- BlackRoad Agent Database Schema
-- D1 SQLite Migration

-- Agent task history
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    priority TEXT NOT NULL CHECK (priority IN ('critical', 'high', 'medium', 'low')),
    status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'retrying')),
    payload TEXT, -- JSON
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    completed_at INTEGER,
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,
    error TEXT,
    result TEXT -- JSON
);

-- Repository tracking
CREATE TABLE IF NOT EXISTS repos (
    name TEXT PRIMARY KEY,
    full_name TEXT NOT NULL,
    url TEXT NOT NULL,
    default_branch TEXT DEFAULT 'main',
    is_monitored INTEGER DEFAULT 1,
    last_sync_at INTEGER,
    cohesion_score INTEGER DEFAULT 100,
    tags TEXT, -- JSON array
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- Cohesion issues
CREATE TABLE IF NOT EXISTS cohesion_issues (
    id TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    type TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
    message TEXT NOT NULL,
    auto_fixable INTEGER DEFAULT 0,
    suggested_fix TEXT,
    status TEXT DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'ignored')),
    created_at INTEGER NOT NULL,
    resolved_at INTEGER,
    FOREIGN KEY (repo) REFERENCES repos(name)
);

-- Resolution actions
CREATE TABLE IF NOT EXISTS resolution_actions (
    id TEXT PRIMARY KEY,
    issue_id TEXT NOT NULL,
    repo TEXT NOT NULL,
    action TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'executing', 'completed', 'failed', 'needs_review')),
    created_at INTEGER NOT NULL,
    executed_at INTEGER,
    result TEXT,
    error TEXT,
    FOREIGN KEY (issue_id) REFERENCES cohesion_issues(id),
    FOREIGN KEY (repo) REFERENCES repos(name)
);

-- Agent health metrics
CREATE TABLE IF NOT EXISTS agent_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_name TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    status TEXT NOT NULL,
    tasks_processed INTEGER DEFAULT 0,
    errors_encountered INTEGER DEFAULT 0,
    avg_task_duration REAL,
    success_rate REAL,
    metadata TEXT -- JSON
);

-- Webhook events log
CREATE TABLE IF NOT EXISTS webhook_events (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    repo TEXT,
    payload TEXT, -- JSON
    processed INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    processed_at INTEGER
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_type ON tasks(type);
CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_repos_monitored ON repos(is_monitored);
CREATE INDEX IF NOT EXISTS idx_repos_cohesion ON repos(cohesion_score);

CREATE INDEX IF NOT EXISTS idx_issues_repo ON cohesion_issues(repo);
CREATE INDEX IF NOT EXISTS idx_issues_status ON cohesion_issues(status);
CREATE INDEX IF NOT EXISTS idx_issues_severity ON cohesion_issues(severity);

CREATE INDEX IF NOT EXISTS idx_actions_status ON resolution_actions(status);
CREATE INDEX IF NOT EXISTS idx_actions_repo ON resolution_actions(repo);

CREATE INDEX IF NOT EXISTS idx_metrics_agent ON agent_metrics(agent_name);
CREATE INDEX IF NOT EXISTS idx_metrics_timestamp ON agent_metrics(timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_webhooks_processed ON webhook_events(processed);
CREATE INDEX IF NOT EXISTS idx_webhooks_created ON webhook_events(created_at DESC);
