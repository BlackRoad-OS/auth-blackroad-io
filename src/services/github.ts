// src/services/github.ts
// GitHub API Service - Handles all GitHub interactions

import type { GitHubRepo, GitHubWorkflowRun } from '../types';

interface GitHubOptions {
  token?: string;
  org?: string;
}

export class GitHubService {
  private token?: string;
  private org: string;
  private baseUrl = 'https://api.github.com';

  constructor(options: GitHubOptions = {}) {
    this.token = options.token;
    this.org = options.org || 'BlackRoad-OS';
  }

  private get headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    return headers;
  }

  async getOrgRepos(): Promise<GitHubRepo[]> {
    const response = await fetch(`${this.baseUrl}/orgs/${this.org}/repos?per_page=100`, {
      headers: this.headers,
    });

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status}`);
    }

    return response.json();
  }

  async getRepo(name: string): Promise<GitHubRepo> {
    const response = await fetch(`${this.baseUrl}/repos/${this.org}/${name}`, {
      headers: this.headers,
    });

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status}`);
    }

    return response.json();
  }

  async getFileContent(repo: string, path: string): Promise<{ content: string; sha: string } | null> {
    const response = await fetch(`${this.baseUrl}/repos/${this.org}/${repo}/contents/${path}`, {
      headers: this.headers,
    });

    if (!response.ok) {
      if (response.status === 404) return null;
      throw new Error(`GitHub API error: ${response.status}`);
    }

    const data = await response.json() as { content: string; sha: string };
    return {
      content: atob(data.content),
      sha: data.sha,
    };
  }

  async getWorkflowRuns(repo: string, limit = 10): Promise<GitHubWorkflowRun[]> {
    const response = await fetch(
      `${this.baseUrl}/repos/${this.org}/${repo}/actions/runs?per_page=${limit}`,
      { headers: this.headers }
    );

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status}`);
    }

    const data = await response.json() as { workflow_runs: GitHubWorkflowRun[] };
    return data.workflow_runs;
  }

  async triggerWorkflow(repo: string, workflow: string, ref = 'main'): Promise<boolean> {
    if (!this.token) {
      console.log('No token configured for workflow dispatch');
      return false;
    }

    const response = await fetch(
      `${this.baseUrl}/repos/${this.org}/${repo}/actions/workflows/${workflow}/dispatches`,
      {
        method: 'POST',
        headers: {
          ...this.headers,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ref }),
      }
    );

    return response.ok || response.status === 204;
  }

  async createIssue(repo: string, title: string, body: string, labels: string[] = []): Promise<string | null> {
    if (!this.token) {
      console.log('No token configured for issue creation');
      return null;
    }

    const response = await fetch(`${this.baseUrl}/repos/${this.org}/${repo}/issues`, {
      method: 'POST',
      headers: {
        ...this.headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title, body, labels }),
    });

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status}`);
    }

    const data = await response.json() as { html_url: string };
    return data.html_url;
  }

  async createPullRequest(
    repo: string,
    title: string,
    body: string,
    head: string,
    base = 'main'
  ): Promise<string | null> {
    if (!this.token) {
      console.log('No token configured for PR creation');
      return null;
    }

    const response = await fetch(`${this.baseUrl}/repos/${this.org}/${repo}/pulls`, {
      method: 'POST',
      headers: {
        ...this.headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title, body, head, base }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`GitHub API error: ${response.status} - ${error}`);
    }

    const data = await response.json() as { html_url: string };
    return data.html_url;
  }

  async createOrUpdateFile(
    repo: string,
    path: string,
    content: string,
    message: string,
    sha?: string,
    branch = 'main'
  ): Promise<boolean> {
    if (!this.token) {
      console.log('No token configured for file operations');
      return false;
    }

    const response = await fetch(`${this.baseUrl}/repos/${this.org}/${repo}/contents/${path}`, {
      method: 'PUT',
      headers: {
        ...this.headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message,
        content: btoa(content),
        sha,
        branch,
      }),
    });

    return response.ok;
  }

  async getSecurityAlerts(repo: string): Promise<number> {
    try {
      const response = await fetch(
        `${this.baseUrl}/repos/${this.org}/${repo}/dependabot/alerts?state=open&per_page=100`,
        { headers: this.headers }
      );

      if (!response.ok) return 0;

      const data = await response.json() as Array<unknown>;
      return data.length;
    } catch {
      return 0;
    }
  }

  async compareCommits(repo: string, base: string, head: string): Promise<{
    ahead_by: number;
    behind_by: number;
    files: Array<{ filename: string; status: string }>;
  }> {
    const response = await fetch(
      `${this.baseUrl}/repos/${this.org}/${repo}/compare/${base}...${head}`,
      { headers: this.headers }
    );

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status}`);
    }

    return response.json();
  }
}

// Retry wrapper with exponential backoff
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelay = 1000
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      if (attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}
