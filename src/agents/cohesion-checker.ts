// src/agents/cohesion-checker.ts
// Cohesion Checker - Ensures consistency across all BlackRoad repos

import type {
  Env,
  CohesionReport,
  RepoAnalysis,
  CohesionIssue,
  AgentTask,
  IssueType,
} from '../types';
import { BLACKROAD_COLORS, BLACKROAD_REPOS } from '../types';

interface CohesionState {
  lastCheckAt: number | null;
  lastReport: CohesionReport | null;
  issues: CohesionIssue[];
  checkHistory: Array<{ timestamp: number; score: number; issueCount: number }>;
}

// Standard workflow that should exist in all repos
const STANDARD_WORKFLOW = `# .github/workflows/autonomous-agent.yml
name: Autonomous Repo Agent

on:
  pull_request:
    types: [opened, synchronize]
  push:
    branches: [main]
  schedule:
    - cron: '0 */6 * * *'

permissions:
  contents: write
  pull-requests: write
  issues: write`;

export class CohesionChecker implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private cohesionState: CohesionState;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;

    this.cohesionState = {
      lastCheckAt: null,
      lastReport: null,
      issues: [],
      checkHistory: [],
    };

    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<CohesionState>('cohesionState');
      if (stored) {
        this.cohesionState = stored;
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

        case '/check':
          return await this.handleCheck();

        case '/deep-check':
          return await this.handleDeepCheck();

        case '/report':
          return this.handleReport();

        case '/issues':
          return this.handleIssues();

        case '/task':
          return await this.handleTask(request);

        default:
          return new Response('Not Found', { status: 404 });
      }
    } catch (error) {
      console.error('CohesionChecker error:', error);
      return new Response(JSON.stringify({ error: String(error) }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  private handleStatus(): Response {
    return new Response(JSON.stringify({
      name: 'CohesionChecker',
      status: 'active',
      lastCheckAt: this.cohesionState.lastCheckAt,
      currentScore: this.cohesionState.lastReport?.overallScore || null,
      openIssues: this.cohesionState.issues.length,
      checkHistory: this.cohesionState.checkHistory.slice(-10),
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleCheck(): Promise<Response> {
    console.log('Running cohesion check');

    const report = await this.runCohesionCheck();

    this.cohesionState.lastCheckAt = Date.now();
    this.cohesionState.lastReport = report;
    this.cohesionState.issues = report.issues;

    this.cohesionState.checkHistory.push({
      timestamp: Date.now(),
      score: report.overallScore,
      issueCount: report.issues.length,
    });

    if (this.cohesionState.checkHistory.length > 100) {
      this.cohesionState.checkHistory = this.cohesionState.checkHistory.slice(-100);
    }

    await this.saveState();

    // If there are critical issues, queue self-resolution tasks
    const criticalIssues = report.issues.filter(i => i.severity === 'critical' && i.autoFixable);
    if (criticalIssues.length > 0 && this.env.AUTO_RESOLVE_ENABLED === 'true') {
      for (const issue of criticalIssues) {
        await this.env.AGENT_TASKS.send({
          id: crypto.randomUUID(),
          type: 'self_resolve',
          priority: 'critical',
          payload: { issueId: issue.id, issue },
          createdAt: Date.now(),
          retryCount: 0,
          maxRetries: 3,
          status: 'pending',
        });
      }
    }

    return new Response(JSON.stringify(report), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleDeepCheck(): Promise<Response> {
    console.log('Running deep cohesion analysis');

    // Deep check includes additional analysis
    const report = await this.runCohesionCheck(true);

    // Store detailed analysis in R2
    const analysisKey = `analysis/${new Date().toISOString()}/cohesion-report.json`;
    await this.env.REPO_SNAPSHOTS.put(analysisKey, JSON.stringify(report), {
      httpMetadata: { contentType: 'application/json' },
    });

    this.cohesionState.lastCheckAt = Date.now();
    this.cohesionState.lastReport = report;
    this.cohesionState.issues = report.issues;

    await this.saveState();

    return new Response(JSON.stringify({
      ...report,
      deepAnalysis: true,
      storedAt: analysisKey,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private handleReport(): Response {
    if (!this.cohesionState.lastReport) {
      return new Response(JSON.stringify({
        error: 'No cohesion report available. Run a check first.',
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify(this.cohesionState.lastReport), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private handleIssues(): Response {
    return new Response(JSON.stringify({
      issues: this.cohesionState.issues,
      count: this.cohesionState.issues.length,
      bySeverity: {
        critical: this.cohesionState.issues.filter(i => i.severity === 'critical').length,
        warning: this.cohesionState.issues.filter(i => i.severity === 'warning').length,
        info: this.cohesionState.issues.filter(i => i.severity === 'info').length,
      },
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleTask(request: Request): Promise<Response> {
    const task = await request.json<AgentTask>();

    if (task.type === 'cohesion_check') {
      return this.handleCheck();
    }

    return new Response(JSON.stringify({ error: 'Unknown task type' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async runCohesionCheck(deep = false): Promise<CohesionReport> {
    const repoAnalyses: RepoAnalysis[] = [];
    const allIssues: CohesionIssue[] = [];
    const recommendations: string[] = [];

    // Analyze each repo
    for (const repoName of BLACKROAD_REPOS) {
      const analysis = await this.analyzeRepo(repoName, deep);
      repoAnalyses.push(analysis.repoAnalysis);
      allIssues.push(...analysis.issues);
    }

    // Cross-repo checks
    const crossRepoIssues = await this.performCrossRepoChecks(repoAnalyses);
    allIssues.push(...crossRepoIssues);

    // Calculate overall score
    const overallScore = this.calculateOverallScore(repoAnalyses, allIssues);

    // Generate recommendations
    if (allIssues.some(i => i.type === 'workflow_missing')) {
      recommendations.push(
        'Deploy the standard autonomous-agent.yml workflow to all repos for consistent automation'
      );
    }

    if (allIssues.some(i => i.type === 'brand_violation')) {
      recommendations.push(
        'Update brand assets to use official BlackRoad colors: ' +
        Object.entries(BLACKROAD_COLORS).map(([k, v]) => `${k}: ${v}`).join(', ')
      );
    }

    if (allIssues.some(i => i.type === 'dependency_mismatch')) {
      recommendations.push(
        'Align dependency versions across repos to prevent compatibility issues'
      );
    }

    if (overallScore < 80) {
      recommendations.push(
        'Consider running a comprehensive cleanup sprint to address accumulated issues'
      );
    }

    return {
      timestamp: Date.now(),
      overallScore,
      repos: repoAnalyses,
      issues: allIssues,
      recommendations,
    };
  }

  private async analyzeRepo(
    repoName: string,
    deep: boolean
  ): Promise<{ repoAnalysis: RepoAnalysis; issues: CohesionIssue[] }> {
    const issues: CohesionIssue[] = [];
    const fullName = `BlackRoad-OS/${repoName}`;

    const metrics = {
      brandCompliance: 100,
      workflowConsistency: 100,
      dependencyAlignment: 100,
      codeStyleMatch: 100,
      documentationQuality: 100,
    };

    // Check workflow consistency
    const workflowCheck = await this.checkWorkflows(fullName, repoName);
    metrics.workflowConsistency = workflowCheck.score;
    issues.push(...workflowCheck.issues);

    // Check brand compliance
    const brandCheck = await this.checkBrandCompliance(fullName, repoName);
    metrics.brandCompliance = brandCheck.score;
    issues.push(...brandCheck.issues);

    // Check documentation
    const docCheck = await this.checkDocumentation(fullName, repoName);
    metrics.documentationQuality = docCheck.score;
    issues.push(...docCheck.issues);

    if (deep) {
      // Additional checks for deep analysis
      const depCheck = await this.checkDependencies(fullName, repoName);
      metrics.dependencyAlignment = depCheck.score;
      issues.push(...depCheck.issues);

      const styleCheck = await this.checkCodeStyle(fullName, repoName);
      metrics.codeStyleMatch = styleCheck.score;
      issues.push(...styleCheck.issues);
    }

    const avgScore = Object.values(metrics).reduce((a, b) => a + b, 0) / Object.values(metrics).length;

    return {
      repoAnalysis: {
        name: repoName,
        score: Math.round(avgScore),
        metrics,
        lastCommit: new Date().toISOString(),
        openIssues: issues.length,
      },
      issues,
    };
  }

  private async checkWorkflows(
    fullName: string,
    repoName: string
  ): Promise<{ score: number; issues: CohesionIssue[] }> {
    const issues: CohesionIssue[] = [];
    let score = 100;

    if (!this.env.GITHUB_TOKEN) {
      return { score, issues };
    }

    try {
      // Check for autonomous-agent workflow
      const response = await fetch(
        `https://api.github.com/repos/${fullName}/contents/.github/workflows/autonomous-agent.yml`,
        {
          headers: {
            'Authorization': `Bearer ${this.env.GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        }
      );

      if (!response.ok) {
        score -= 40;
        issues.push({
          id: crypto.randomUUID(),
          severity: 'critical',
          repo: repoName,
          type: 'workflow_missing',
          message: 'Missing autonomous-agent.yml workflow',
          autoFixable: true,
          suggestedFix: STANDARD_WORKFLOW,
        });
      } else {
        // Check workflow content for consistency
        const data = await response.json() as { content: string };
        const content = atob(data.content);

        if (!content.includes('Autonomous Repo Agent')) {
          score -= 20;
          issues.push({
            id: crypto.randomUUID(),
            severity: 'warning',
            repo: repoName,
            type: 'workflow_outdated',
            message: 'Workflow does not match standard template',
            autoFixable: true,
            suggestedFix: STANDARD_WORKFLOW,
          });
        }
      }

      // Check for auto-merge workflow
      const autoMergeResponse = await fetch(
        `https://api.github.com/repos/${fullName}/contents/.github/workflows/blackroad-auto-merge.yml`,
        {
          headers: {
            'Authorization': `Bearer ${this.env.GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        }
      );

      if (!autoMergeResponse.ok) {
        score -= 10;
        issues.push({
          id: crypto.randomUUID(),
          severity: 'info',
          repo: repoName,
          type: 'workflow_missing',
          message: 'Missing blackroad-auto-merge.yml workflow',
          autoFixable: true,
        });
      }

    } catch (error) {
      console.error(`Error checking workflows for ${repoName}:`, error);
    }

    return { score: Math.max(0, score), issues };
  }

  private async checkBrandCompliance(
    fullName: string,
    repoName: string
  ): Promise<{ score: number; issues: CohesionIssue[] }> {
    const issues: CohesionIssue[] = [];
    let score = 100;

    if (!this.env.GITHUB_TOKEN) {
      return { score, issues };
    }

    try {
      // Check README for branding
      const readmeResponse = await fetch(
        `https://api.github.com/repos/${fullName}/readme`,
        {
          headers: {
            'Authorization': `Bearer ${this.env.GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        }
      );

      if (readmeResponse.ok) {
        const data = await readmeResponse.json() as { content: string };
        const content = atob(data.content);

        // Check for BlackRoad branding
        if (!content.toLowerCase().includes('blackroad')) {
          score -= 20;
          issues.push({
            id: crypto.randomUUID(),
            severity: 'warning',
            repo: repoName,
            type: 'brand_violation',
            message: 'README does not mention BlackRoad branding',
            autoFixable: false,
          });
        }

        // Check for deprecated colors
        const deprecatedColors = ['#FF6B6B', '#4ECDC4', '#45B7D1'];
        for (const color of deprecatedColors) {
          if (content.includes(color)) {
            score -= 10;
            issues.push({
              id: crypto.randomUUID(),
              severity: 'warning',
              repo: repoName,
              type: 'brand_violation',
              message: `Contains deprecated color: ${color}`,
              autoFixable: true,
              suggestedFix: `Replace ${color} with official BlackRoad colors`,
            });
          }
        }
      }

    } catch (error) {
      console.error(`Error checking brand compliance for ${repoName}:`, error);
    }

    return { score: Math.max(0, score), issues };
  }

  private async checkDocumentation(
    fullName: string,
    repoName: string
  ): Promise<{ score: number; issues: CohesionIssue[] }> {
    const issues: CohesionIssue[] = [];
    let score = 100;

    if (!this.env.GITHUB_TOKEN) {
      return { score, issues };
    }

    const requiredDocs = ['README.md', 'LICENSE'];
    const recommendedDocs = ['CONTRIBUTING.md', 'SECURITY.md'];

    for (const doc of requiredDocs) {
      const response = await fetch(
        `https://api.github.com/repos/${fullName}/contents/${doc}`,
        {
          headers: {
            'Authorization': `Bearer ${this.env.GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        }
      );

      if (!response.ok) {
        score -= 25;
        issues.push({
          id: crypto.randomUUID(),
          severity: 'critical',
          repo: repoName,
          type: 'documentation_missing',
          message: `Missing required documentation: ${doc}`,
          autoFixable: false,
        });
      }
    }

    for (const doc of recommendedDocs) {
      const response = await fetch(
        `https://api.github.com/repos/${fullName}/contents/${doc}`,
        {
          headers: {
            'Authorization': `Bearer ${this.env.GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        }
      );

      if (!response.ok) {
        score -= 5;
        issues.push({
          id: crypto.randomUUID(),
          severity: 'info',
          repo: repoName,
          type: 'documentation_missing',
          message: `Missing recommended documentation: ${doc}`,
          autoFixable: false,
        });
      }
    }

    return { score: Math.max(0, score), issues };
  }

  private async checkDependencies(
    fullName: string,
    repoName: string
  ): Promise<{ score: number; issues: CohesionIssue[] }> {
    const issues: CohesionIssue[] = [];
    let score = 100;

    if (!this.env.GITHUB_TOKEN) {
      return { score, issues };
    }

    try {
      const response = await fetch(
        `https://api.github.com/repos/${fullName}/contents/package.json`,
        {
          headers: {
            'Authorization': `Bearer ${this.env.GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        }
      );

      if (response.ok) {
        const data = await response.json() as { content: string };
        const packageJson = JSON.parse(atob(data.content));

        // Check for outdated Node version requirement
        if (packageJson.engines?.node && !packageJson.engines.node.includes('18')) {
          score -= 10;
          issues.push({
            id: crypto.randomUUID(),
            severity: 'warning',
            repo: repoName,
            type: 'dependency_mismatch',
            message: 'Node.js version requirement may be outdated',
            autoFixable: true,
          });
        }

        // Check for missing type definitions in TypeScript projects
        if (packageJson.devDependencies?.typescript && !packageJson.devDependencies['@types/node']) {
          score -= 5;
          issues.push({
            id: crypto.randomUUID(),
            severity: 'info',
            repo: repoName,
            type: 'dependency_mismatch',
            message: 'Missing @types/node for TypeScript project',
            autoFixable: true,
          });
        }
      }

    } catch (error) {
      console.error(`Error checking dependencies for ${repoName}:`, error);
    }

    return { score: Math.max(0, score), issues };
  }

  private async checkCodeStyle(
    fullName: string,
    repoName: string
  ): Promise<{ score: number; issues: CohesionIssue[] }> {
    const issues: CohesionIssue[] = [];
    let score = 100;

    if (!this.env.GITHUB_TOKEN) {
      return { score, issues };
    }

    // Check for linting configuration
    const lintConfigs = ['.eslintrc.json', '.eslintrc.js', 'eslint.config.js'];
    let hasLintConfig = false;

    for (const config of lintConfigs) {
      const response = await fetch(
        `https://api.github.com/repos/${fullName}/contents/${config}`,
        {
          headers: {
            'Authorization': `Bearer ${this.env.GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        }
      );

      if (response.ok) {
        hasLintConfig = true;
        break;
      }
    }

    if (!hasLintConfig) {
      score -= 15;
      issues.push({
        id: crypto.randomUUID(),
        severity: 'info',
        repo: repoName,
        type: 'config_inconsistency',
        message: 'No ESLint configuration found',
        autoFixable: true,
      });
    }

    // Check for Prettier config
    const prettierConfigs = ['.prettierrc', '.prettierrc.json', 'prettier.config.js'];
    let hasPrettierConfig = false;

    for (const config of prettierConfigs) {
      const response = await fetch(
        `https://api.github.com/repos/${fullName}/contents/${config}`,
        {
          headers: {
            'Authorization': `Bearer ${this.env.GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        }
      );

      if (response.ok) {
        hasPrettierConfig = true;
        break;
      }
    }

    if (!hasPrettierConfig) {
      score -= 10;
      issues.push({
        id: crypto.randomUUID(),
        severity: 'info',
        repo: repoName,
        type: 'config_inconsistency',
        message: 'No Prettier configuration found',
        autoFixable: true,
      });
    }

    return { score: Math.max(0, score), issues };
  }

  private async performCrossRepoChecks(repoAnalyses: RepoAnalysis[]): Promise<CohesionIssue[]> {
    const issues: CohesionIssue[] = [];

    // Check for score outliers
    const scores = repoAnalyses.map(r => r.score);
    const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;

    for (const repo of repoAnalyses) {
      if (repo.score < avgScore - 20) {
        issues.push({
          id: crypto.randomUUID(),
          severity: 'warning',
          repo: repo.name,
          type: 'config_inconsistency',
          message: `Repo cohesion score (${repo.score}) is significantly below average (${Math.round(avgScore)})`,
          autoFixable: false,
        });
      }
    }

    return issues;
  }

  private calculateOverallScore(repoAnalyses: RepoAnalysis[], issues: CohesionIssue[]): number {
    if (repoAnalyses.length === 0) return 100;

    // Base score from repo analyses
    const baseScore = repoAnalyses.reduce((sum, r) => sum + r.score, 0) / repoAnalyses.length;

    // Deduct for critical issues
    const criticalIssues = issues.filter(i => i.severity === 'critical').length;
    const warningIssues = issues.filter(i => i.severity === 'warning').length;

    const penalty = (criticalIssues * 5) + (warningIssues * 2);

    return Math.max(0, Math.round(baseScore - penalty));
  }

  private async saveState(): Promise<void> {
    await this.state.storage.put('cohesionState', this.cohesionState);
  }
}
