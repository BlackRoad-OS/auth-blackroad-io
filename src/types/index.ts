// src/types/index.ts
// Type definitions for BlackRoad Autonomous Agent System

export interface Env {
  // KV Namespaces
  AGENT_STATE: KVNamespace;
  REPO_CACHE: KVNamespace;
  TASK_QUEUE: KVNamespace;

  // Durable Objects
  AUTONOMOUS_AGENT: DurableObjectNamespace;
  REPO_MONITOR: DurableObjectNamespace;
  COHESION_CHECKER: DurableObjectNamespace;
  SELF_RESOLVER: DurableObjectNamespace;

  // Queue
  AGENT_TASKS: Queue<AgentTask>;

  // R2 Bucket
  REPO_SNAPSHOTS: R2Bucket;

  // D1 Database
  AGENT_DB: D1Database;

  // Analytics
  AGENT_ANALYTICS: AnalyticsEngineDataset;

  // Environment Variables
  ENVIRONMENT: string;
  BLACKROAD_BRAND: string;
  AUTO_RESOLVE_ENABLED: string;
  COHESION_CHECK_INTERVAL: string;

  // Secrets (set in Cloudflare dashboard or wrangler secrets)
  GITHUB_TOKEN?: string;
  GITHUB_APP_ID?: string;
  GITHUB_PRIVATE_KEY?: string;
}

export interface AgentTask {
  id: string;
  type: TaskType;
  priority: Priority;
  payload: Record<string, unknown>;
  createdAt: number;
  retryCount: number;
  maxRetries: number;
  status: TaskStatus;
}

export type TaskType =
  | 'repo_scan'
  | 'cohesion_check'
  | 'self_resolve'
  | 'sync_repos'
  | 'health_check'
  | 'trigger_workflow'
  | 'update_deps'
  | 'analyze_changes';

export type Priority = 'critical' | 'high' | 'medium' | 'low';

export type TaskStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'retrying';

export interface RepoConfig {
  name: string;
  fullName: string;
  url: string;
  defaultBranch: string;
  isMonitored: boolean;
  lastSyncAt: number | null;
  cohesionScore: number;
  tags: string[];
}

export interface CohesionReport {
  timestamp: number;
  overallScore: number;
  repos: RepoAnalysis[];
  issues: CohesionIssue[];
  recommendations: string[];
}

export interface RepoAnalysis {
  name: string;
  score: number;
  metrics: {
    brandCompliance: number;
    workflowConsistency: number;
    dependencyAlignment: number;
    codeStyleMatch: number;
    documentationQuality: number;
  };
  lastCommit: string;
  openIssues: number;
}

export interface CohesionIssue {
  id: string;
  severity: 'critical' | 'warning' | 'info';
  repo: string;
  type: IssueType;
  message: string;
  autoFixable: boolean;
  suggestedFix?: string;
}

export type IssueType =
  | 'brand_violation'
  | 'workflow_missing'
  | 'workflow_outdated'
  | 'dependency_mismatch'
  | 'security_vulnerability'
  | 'documentation_missing'
  | 'config_inconsistency';

export interface SelfResolutionAction {
  id: string;
  issueId: string;
  repo: string;
  action: ResolutionType;
  status: 'pending' | 'executing' | 'completed' | 'failed' | 'needs_review';
  createdAt: number;
  executedAt?: number;
  result?: string;
  error?: string;
}

export type ResolutionType =
  | 'create_pr'
  | 'trigger_workflow'
  | 'update_config'
  | 'create_issue'
  | 'notify_team'
  | 'rollback'
  | 'retry_failed_job';

export interface AgentState {
  id: string;
  name: string;
  status: 'idle' | 'active' | 'error' | 'maintenance';
  lastHeartbeat: number;
  tasksProcessed: number;
  errorsEncountered: number;
  currentTask?: AgentTask;
  metrics: AgentMetrics;
}

export interface AgentMetrics {
  uptime: number;
  avgTaskDuration: number;
  successRate: number;
  lastErrorAt?: number;
  lastSuccessAt?: number;
}

// BlackRoad specific branding
export const BLACKROAD_COLORS = {
  hotPink: '#FF1D6C',
  amber: '#F5A623',
  electricBlue: '#2979FF',
  violet: '#9C27B0',
  black: '#000000',
  white: '#FFFFFF',
} as const;

export const BLACKROAD_REPOS = [
  'blackroad-prism-console',
  'auth-blackroad-io',
  'blackroad-cli',
  'blackroad-sdk',
  'blackroad-docs',
] as const;

export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  html_url: string;
  description: string | null;
  default_branch: string;
  pushed_at: string;
  created_at: string;
  updated_at: string;
  language: string | null;
  visibility: string;
  topics: string[];
}

export interface GitHubWorkflowRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  created_at: string;
  updated_at: string;
  html_url: string;
}
