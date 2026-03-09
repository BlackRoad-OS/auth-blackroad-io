// src/agents/repo-monitor.ts
// Repository Monitor - Scrapes and tracks all BlackRoad repos

import type { Env, RepoConfig, GitHubRepo, AgentTask } from '../types';
import { BLACKROAD_REPOS } from '../types';

interface MonitorState {
  lastSyncAt: number | null;
  repos: Map<string, RepoConfig>;
  scanHistory: Array<{ timestamp: number; reposScanned: number; issues: number }>;
}

export class RepoMonitor implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private monitorState: MonitorState;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;

    this.monitorState = {
      lastSyncAt: null,
      repos: new Map(),
      scanHistory: [],
    };

    // Restore state
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<{
        lastSyncAt: number | null;
        repos: Array<[string, RepoConfig]>;
        scanHistory: Array<{ timestamp: number; reposScanned: number; issues: number }>;
      }>('monitorState');

      if (stored) {
        this.monitorState = {
          ...stored,
          repos: new Map(stored.repos),
        };
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      switch (path) {
        case '/status':
          return this.handleStatus();

        case '/scan':
          return await this.handleScan(request);

        case '/sync':
          return await this.handleSync();

        case '/repos':
          return this.handleGetRepos();

        case '/task':
          return await this.handleTask(request);

        default:
          return new Response('Not Found', { status: 404 });
      }
    } catch (error) {
      console.error('RepoMonitor error:', error);
      return new Response(JSON.stringify({ error: String(error) }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  private handleStatus(): Response {
    return new Response(JSON.stringify({
      name: 'RepoMonitor',
      status: 'active',
      lastSyncAt: this.monitorState.lastSyncAt,
      reposTracked: this.monitorState.repos.size,
      scanHistory: this.monitorState.scanHistory.slice(-10),
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleScan(request: Request): Promise<Response> {
    const body = await request.json<{ repos?: string[] }>();
    const reposToScan = body.repos || Array.from(BLACKROAD_REPOS);

    console.log(`Starting scan of ${reposToScan.length} repos`);

    const results = await this.scanRepos(reposToScan);

    this.monitorState.scanHistory.push({
      timestamp: Date.now(),
      reposScanned: results.scanned,
      issues: results.issues.length,
    });

    // Keep only last 100 scans
    if (this.monitorState.scanHistory.length > 100) {
      this.monitorState.scanHistory = this.monitorState.scanHistory.slice(-100);
    }

    await this.saveState();

    return new Response(JSON.stringify(results), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleSync(): Promise<Response> {
    console.log('Starting full repo sync');

    // Fetch all repos from GitHub org
    const repos = await this.fetchOrgRepos();

    // Update local state
    for (const repo of repos) {
      const config = this.monitorState.repos.get(repo.name) || {
        name: repo.name,
        fullName: repo.full_name,
        url: repo.html_url,
        defaultBranch: repo.default_branch,
        isMonitored: true,
        lastSyncAt: null,
        cohesionScore: 100,
        tags: repo.topics || [],
      };

      config.lastSyncAt = Date.now();
      this.monitorState.repos.set(repo.name, config);

      // Cache repo data
      await this.env.REPO_CACHE.put(
        `repo:${repo.name}`,
        JSON.stringify(repo),
        { expirationTtl: 3600 }
      );
    }

    this.monitorState.lastSyncAt = Date.now();
    await this.saveState();

    // Snapshot to R2 for historical analysis
    await this.createSnapshot(repos);

    return new Response(JSON.stringify({
      synced: true,
      reposFound: repos.length,
      timestamp: this.monitorState.lastSyncAt,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private handleGetRepos(): Response {
    const repos = Array.from(this.monitorState.repos.values());
    return new Response(JSON.stringify({ repos }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleTask(request: Request): Promise<Response> {
    const task = await request.json<AgentTask>();

    switch (task.type) {
      case 'repo_scan':
        const scanResult = await this.scanRepos(
          (task.payload.repos as string[]) || Array.from(BLACKROAD_REPOS)
        );
        return new Response(JSON.stringify(scanResult), {
          headers: { 'Content-Type': 'application/json' },
        });

      case 'sync_repos':
        return this.handleSync();

      default:
        return new Response(JSON.stringify({ error: 'Unknown task type' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
    }
  }

  private async fetchOrgRepos(): Promise<GitHubRepo[]> {
    if (!this.env.GITHUB_TOKEN) {
      console.log('No GitHub token, using cached repos');
      return this.getCachedRepos();
    }

    try {
      const response = await fetch('https://api.github.com/orgs/BlackRoad-OS/repos', {
        headers: {
          'Authorization': `Bearer ${this.env.GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });

      if (!response.ok) {
        console.warn(`GitHub API returned ${response.status}`);
        return this.getCachedRepos();
      }

      return await response.json();
    } catch (error) {
      console.error('Failed to fetch org repos:', error);
      return this.getCachedRepos();
    }
  }

  private async getCachedRepos(): Promise<GitHubRepo[]> {
    const repos: GitHubRepo[] = [];

    for (const repoName of BLACKROAD_REPOS) {
      const cached = await this.env.REPO_CACHE.get(`repo:${repoName}`);
      if (cached) {
        repos.push(JSON.parse(cached));
      }
    }

    return repos;
  }

  private async scanRepos(repoNames: string[]): Promise<{
    scanned: number;
    issues: Array<{ repo: string; issue: string; severity: string }>;
    recommendations: string[];
  }> {
    const issues: Array<{ repo: string; issue: string; severity: string }> = [];
    const recommendations: string[] = [];

    for (const repoName of repoNames) {
      try {
        const repoIssues = await this.scanRepo(repoName);
        issues.push(...repoIssues);
      } catch (error) {
        issues.push({
          repo: repoName,
          issue: `Scan failed: ${error}`,
          severity: 'warning',
        });
      }
    }

    // Generate recommendations based on issues
    if (issues.some(i => i.issue.includes('workflow'))) {
      recommendations.push('Consider syncing workflow files across repos for consistency');
    }

    if (issues.some(i => i.issue.includes('dependency'))) {
      recommendations.push('Update outdated dependencies across all repos');
    }

    return {
      scanned: repoNames.length,
      issues,
      recommendations,
    };
  }

  private async scanRepo(repoName: string): Promise<Array<{ repo: string; issue: string; severity: string }>> {
    const issues: Array<{ repo: string; issue: string; severity: string }> = [];

    if (!this.env.GITHUB_TOKEN) {
      return issues;
    }

    const fullName = `BlackRoad-OS/${repoName}`;

    try {
      // Check for required files
      const requiredFiles = [
        '.github/workflows/autonomous-agent.yml',
        'LICENSE',
        'README.md',
      ];

      for (const file of requiredFiles) {
        const response = await fetch(
          `https://api.github.com/repos/${fullName}/contents/${file}`,
          {
            headers: {
              'Authorization': `Bearer ${this.env.GITHUB_TOKEN}`,
              'Accept': 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2022-11-28',
            },
          }
        );

        if (!response.ok) {
          issues.push({
            repo: repoName,
            issue: `Missing required file: ${file}`,
            severity: file.includes('workflow') ? 'critical' : 'warning',
          });
        }
      }

      // Check workflow runs
      const workflowResponse = await fetch(
        `https://api.github.com/repos/${fullName}/actions/runs?per_page=5`,
        {
          headers: {
            'Authorization': `Bearer ${this.env.GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        }
      );

      if (workflowResponse.ok) {
        const workflowData = await workflowResponse.json() as {
          workflow_runs: Array<{ conclusion: string; name: string }>;
        };

        const failedRuns = workflowData.workflow_runs?.filter(
          run => run.conclusion === 'failure'
        );

        if (failedRuns && failedRuns.length > 0) {
          issues.push({
            repo: repoName,
            issue: `${failedRuns.length} recent workflow failures`,
            severity: 'warning',
          });
        }
      }

      // Check for security vulnerabilities
      const alertsResponse = await fetch(
        `https://api.github.com/repos/${fullName}/vulnerability-alerts`,
        {
          headers: {
            'Authorization': `Bearer ${this.env.GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        }
      );

      // 204 means alerts are enabled, we'd need separate call for actual alerts
      // For now just check if vulnerability scanning is enabled

    } catch (error) {
      console.error(`Error scanning repo ${repoName}:`, error);
    }

    return issues;
  }

  private async createSnapshot(repos: GitHubRepo[]): Promise<void> {
    const snapshot = {
      timestamp: Date.now(),
      repos: repos.map(r => ({
        name: r.name,
        fullName: r.full_name,
        language: r.language,
        pushedAt: r.pushed_at,
        topics: r.topics,
      })),
    };

    const key = `snapshots/${new Date().toISOString().split('T')[0]}/repos.json`;

    await this.env.REPO_SNAPSHOTS.put(key, JSON.stringify(snapshot), {
      httpMetadata: { contentType: 'application/json' },
    });
  }

  private async saveState(): Promise<void> {
    await this.state.storage.put('monitorState', {
      lastSyncAt: this.monitorState.lastSyncAt,
      repos: Array.from(this.monitorState.repos.entries()),
      scanHistory: this.monitorState.scanHistory,
    });
  }
}
