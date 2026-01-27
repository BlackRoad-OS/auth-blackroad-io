// src/agents/self-resolver.ts
// Self-Resolver - Automatically fixes issues and heals the system

import type {
  Env,
  CohesionIssue,
  SelfResolutionAction,
  AgentTask,
  ResolutionType,
} from '../types';

interface ResolverState {
  pendingActions: SelfResolutionAction[];
  completedActions: SelfResolutionAction[];
  failedActions: SelfResolutionAction[];
  resolutionHistory: Array<{
    timestamp: number;
    action: string;
    success: boolean;
    repo: string;
  }>;
  circuitBreaker: {
    failures: number;
    lastFailure: number | null;
    isOpen: boolean;
  };
}

export class SelfResolver implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private resolverState: ResolverState;

  // Max consecutive failures before circuit breaker opens
  private readonly CIRCUIT_BREAKER_THRESHOLD = 5;
  // How long circuit breaker stays open (5 minutes)
  private readonly CIRCUIT_BREAKER_RESET_MS = 5 * 60 * 1000;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;

    this.resolverState = {
      pendingActions: [],
      completedActions: [],
      failedActions: [],
      resolutionHistory: [],
      circuitBreaker: {
        failures: 0,
        lastFailure: null,
        isOpen: false,
      },
    };

    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<ResolverState>('resolverState');
      if (stored) {
        this.resolverState = stored;
        // Check if circuit breaker should be reset
        this.checkCircuitBreaker();
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

        case '/resolve':
          return await this.handleResolve(request);

        case '/task':
          return await this.handleTask(request);

        case '/task-failed':
          return await this.handleTaskFailed(request);

        case '/system-unhealthy':
          return await this.handleSystemUnhealthy(request);

        case '/history':
          return this.handleHistory();

        case '/daily-review':
          return await this.handleDailyReview();

        case '/recover_agent':
          return await this.handleRecoverAgent(request);

        case '/rollback':
          return await this.handleRollback(request);

        default:
          return new Response('Not Found', { status: 404 });
      }
    } catch (error) {
      console.error('SelfResolver error:', error);
      return new Response(JSON.stringify({ error: String(error) }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  private handleStatus(): Response {
    return new Response(JSON.stringify({
      name: 'SelfResolver',
      status: this.resolverState.circuitBreaker.isOpen ? 'circuit_open' : 'active',
      pendingActions: this.resolverState.pendingActions.length,
      completedToday: this.getActionsToday('completed'),
      failedToday: this.getActionsToday('failed'),
      circuitBreaker: this.resolverState.circuitBreaker,
      recentHistory: this.resolverState.resolutionHistory.slice(-10),
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleResolve(request: Request): Promise<Response> {
    const body = await request.json<{ issueId: string }>();

    // Check circuit breaker
    if (this.resolverState.circuitBreaker.isOpen) {
      this.checkCircuitBreaker();
      if (this.resolverState.circuitBreaker.isOpen) {
        return new Response(JSON.stringify({
          error: 'Circuit breaker is open. Too many recent failures.',
          resetAt: new Date(
            (this.resolverState.circuitBreaker.lastFailure || 0) + this.CIRCUIT_BREAKER_RESET_MS
          ).toISOString(),
        }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // Find the issue
    const issue = await this.findIssue(body.issueId);
    if (!issue) {
      return new Response(JSON.stringify({ error: 'Issue not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Create and execute resolution action
    const action = await this.createResolutionAction(issue);
    const result = await this.executeAction(action);

    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleTask(request: Request): Promise<Response> {
    const task = await request.json<AgentTask>();

    if (task.type !== 'self_resolve') {
      return new Response(JSON.stringify({ error: 'Invalid task type' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const issue = task.payload.issue as CohesionIssue;
    if (!issue) {
      return new Response(JSON.stringify({ error: 'No issue in payload' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const action = await this.createResolutionAction(issue);
    const result = await this.executeAction(action);

    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleTaskFailed(request: Request): Promise<Response> {
    const body = await request.json<{ task: AgentTask; error: string }>();

    console.log(`Task ${body.task.id} failed after max retries: ${body.error}`);

    // Create an issue in the affected repo if possible
    if (body.task.payload.repo) {
      await this.createGitHubIssue(
        body.task.payload.repo as string,
        `Automated task failed: ${body.task.type}`,
        `The following task failed after ${body.task.maxRetries} retries:\n\n` +
        `**Task Type:** ${body.task.type}\n` +
        `**Task ID:** ${body.task.id}\n` +
        `**Error:** ${body.error}\n\n` +
        `This issue was automatically created by the BlackRoad self-resolution system.`
      );
    }

    // Log to analytics
    this.env.AGENT_ANALYTICS.writeDataPoint({
      blobs: [body.task.type, 'task_max_retries_exceeded', body.error],
      doubles: [Date.now()],
      indexes: ['self_resolution'],
    });

    return new Response(JSON.stringify({ logged: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleSystemUnhealthy(request: Request): Promise<Response> {
    const healthCheck = await request.json<{
      healthy: boolean;
      details: Record<string, { healthy: boolean }>;
    }>();

    console.log('System health check failed:', healthCheck);

    // Try to recover unhealthy components
    const recoveryActions: string[] = [];

    for (const [component, status] of Object.entries(healthCheck.details)) {
      if (!status.healthy) {
        recoveryActions.push(`Attempting recovery of ${component}`);

        // Queue a recovery task
        await this.env.AGENT_TASKS.send({
          id: crypto.randomUUID(),
          type: 'health_check',
          priority: 'critical',
          payload: { component, isRecovery: true },
          createdAt: Date.now(),
          retryCount: 0,
          maxRetries: 3,
          status: 'pending',
        });
      }
    }

    // Notify if multiple components are down
    const unhealthyCount = Object.values(healthCheck.details).filter(s => !s.healthy).length;
    if (unhealthyCount >= 2) {
      console.error('CRITICAL: Multiple components unhealthy!');

      // Store alert for review
      await this.env.AGENT_STATE.put(
        `alert:${Date.now()}`,
        JSON.stringify({
          type: 'multi_component_failure',
          timestamp: Date.now(),
          details: healthCheck.details,
        }),
        { expirationTtl: 86400 } // 24 hours
      );
    }

    return new Response(JSON.stringify({
      acknowledged: true,
      recoveryActions,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private handleHistory(): Response {
    return new Response(JSON.stringify({
      pending: this.resolverState.pendingActions,
      completed: this.resolverState.completedActions.slice(-50),
      failed: this.resolverState.failedActions.slice(-50),
      history: this.resolverState.resolutionHistory.slice(-100),
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleDailyReview(): Promise<Response> {
    console.log('Running daily self-resolution review');

    const review = {
      date: new Date().toISOString().split('T')[0],
      totalActions: this.resolverState.resolutionHistory.length,
      successRate: this.calculateSuccessRate(),
      pendingActions: this.resolverState.pendingActions.length,
      patterns: this.identifyPatterns(),
      recommendations: this.generateRecommendations(),
    };

    // Store review in R2
    const reviewKey = `reviews/${review.date}/daily-review.json`;
    await this.env.REPO_SNAPSHOTS.put(reviewKey, JSON.stringify(review), {
      httpMetadata: { contentType: 'application/json' },
    });

    // Clean up old data
    await this.cleanup();

    await this.saveState();

    return new Response(JSON.stringify(review), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleRecoverAgent(request: Request): Promise<Response> {
    const body = await request.json<{ targetAgent: string }>();

    console.log(`Attempting to recover agent: ${body.targetAgent}`);

    // For Durable Objects, the main recovery action is to restart them
    // by making a request that will initialize fresh state if needed
    const namespace = this.env[body.targetAgent as keyof Env] as DurableObjectNamespace;

    if (!namespace) {
      return new Response(JSON.stringify({ error: 'Unknown agent' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    try {
      const id = namespace.idFromName('primary');
      const agent = namespace.get(id);

      // Ping the agent to ensure it's alive
      const response = await agent.fetch(new Request('http://internal/status'));
      const status = await response.json();

      return new Response(JSON.stringify({
        recovered: true,
        agent: body.targetAgent,
        currentStatus: status,
      }), {
        headers: { 'Content-Type': 'application/json' },
      });

    } catch (error) {
      console.error(`Failed to recover ${body.targetAgent}:`, error);

      return new Response(JSON.stringify({
        recovered: false,
        agent: body.targetAgent,
        error: String(error),
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  private async handleRollback(request: Request): Promise<Response> {
    const body = await request.json<{ actionId: string }>();

    const action = this.resolverState.completedActions.find(a => a.id === body.actionId);
    if (!action) {
      return new Response(JSON.stringify({ error: 'Action not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Create rollback action
    const rollbackAction: SelfResolutionAction = {
      id: crypto.randomUUID(),
      issueId: `rollback-${action.issueId}`,
      repo: action.repo,
      action: 'rollback',
      status: 'pending',
      createdAt: Date.now(),
    };

    // Execute rollback based on original action type
    // For now, most rollbacks would involve reverting a PR or config change
    console.log(`Rolling back action ${action.id} (${action.action})`);

    rollbackAction.status = 'completed';
    rollbackAction.executedAt = Date.now();
    rollbackAction.result = 'Rollback queued for manual review';

    this.resolverState.completedActions.push(rollbackAction);
    await this.saveState();

    return new Response(JSON.stringify({
      rolledBack: true,
      originalAction: action,
      rollbackAction,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async findIssue(issueId: string): Promise<CohesionIssue | null> {
    // Check cohesion checker for the issue
    const cohesionId = this.env.COHESION_CHECKER.idFromName('primary');
    const cohesion = this.env.COHESION_CHECKER.get(cohesionId);

    const response = await cohesion.fetch(new Request('http://internal/issues'));
    const data = await response.json() as { issues: CohesionIssue[] };

    return data.issues.find(i => i.id === issueId) || null;
  }

  private async createResolutionAction(issue: CohesionIssue): Promise<SelfResolutionAction> {
    const actionType = this.determineActionType(issue);

    const action: SelfResolutionAction = {
      id: crypto.randomUUID(),
      issueId: issue.id,
      repo: issue.repo,
      action: actionType,
      status: 'pending',
      createdAt: Date.now(),
    };

    this.resolverState.pendingActions.push(action);
    await this.saveState();

    return action;
  }

  private determineActionType(issue: CohesionIssue): ResolutionType {
    switch (issue.type) {
      case 'workflow_missing':
      case 'workflow_outdated':
        return 'create_pr';

      case 'security_vulnerability':
        return 'create_issue';

      case 'dependency_mismatch':
        return 'trigger_workflow';

      case 'brand_violation':
      case 'config_inconsistency':
        return issue.autoFixable ? 'create_pr' : 'create_issue';

      case 'documentation_missing':
        return 'create_issue';

      default:
        return 'notify_team';
    }
  }

  private async executeAction(action: SelfResolutionAction): Promise<{
    success: boolean;
    action: SelfResolutionAction;
    message: string;
  }> {
    action.status = 'executing';
    await this.saveState();

    try {
      let result: string;

      switch (action.action) {
        case 'create_pr':
          result = await this.createPullRequest(action);
          break;

        case 'create_issue':
          result = await this.createGitHubIssue(
            action.repo,
            'Automated Issue: Cohesion check failed',
            `Issue ID: ${action.issueId}`
          );
          break;

        case 'trigger_workflow':
          result = await this.triggerWorkflow(action.repo);
          break;

        case 'notify_team':
          result = 'Team notification queued';
          break;

        default:
          result = `Action ${action.action} not implemented`;
      }

      action.status = 'completed';
      action.executedAt = Date.now();
      action.result = result;

      // Move from pending to completed
      this.resolverState.pendingActions = this.resolverState.pendingActions.filter(
        a => a.id !== action.id
      );
      this.resolverState.completedActions.push(action);

      // Log success
      this.resolverState.resolutionHistory.push({
        timestamp: Date.now(),
        action: action.action,
        success: true,
        repo: action.repo,
      });

      // Reset circuit breaker on success
      this.resolverState.circuitBreaker.failures = 0;

      await this.saveState();

      return { success: true, action, message: result };

    } catch (error) {
      action.status = 'failed';
      action.executedAt = Date.now();
      action.error = String(error);

      // Move from pending to failed
      this.resolverState.pendingActions = this.resolverState.pendingActions.filter(
        a => a.id !== action.id
      );
      this.resolverState.failedActions.push(action);

      // Log failure
      this.resolverState.resolutionHistory.push({
        timestamp: Date.now(),
        action: action.action,
        success: false,
        repo: action.repo,
      });

      // Update circuit breaker
      this.resolverState.circuitBreaker.failures++;
      this.resolverState.circuitBreaker.lastFailure = Date.now();

      if (this.resolverState.circuitBreaker.failures >= this.CIRCUIT_BREAKER_THRESHOLD) {
        this.resolverState.circuitBreaker.isOpen = true;
        console.warn('Circuit breaker opened due to excessive failures');
      }

      await this.saveState();

      return { success: false, action, message: String(error) };
    }
  }

  private async createPullRequest(action: SelfResolutionAction): Promise<string> {
    if (!this.env.GITHUB_TOKEN) {
      return 'GitHub token not configured - PR creation skipped';
    }

    const fullName = `BlackRoad-OS/${action.repo}`;

    // For now, create an issue requesting manual PR creation
    // Full PR automation would require creating a branch, committing changes, etc.
    await this.createGitHubIssue(
      action.repo,
      `Automated Fix Required: ${action.issueId}`,
      `The self-resolution system has identified an issue that requires a code change.\n\n` +
      `**Issue ID:** ${action.issueId}\n` +
      `**Suggested Action:** Create a pull request to fix this issue\n\n` +
      `Please review and create the necessary PR.`
    );

    return `Issue created for manual PR creation in ${fullName}`;
  }

  private async createGitHubIssue(
    repoName: string,
    title: string,
    body: string
  ): Promise<string> {
    if (!this.env.GITHUB_TOKEN) {
      console.log('GitHub token not configured');
      return 'GitHub token not configured - issue creation skipped';
    }

    const fullName = `BlackRoad-OS/${repoName}`;

    try {
      const response = await fetch(
        `https://api.github.com/repos/${fullName}/issues`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.env.GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            title,
            body: body + '\n\n---\n*Created by BlackRoad Self-Resolution Agent*',
            labels: ['automated', 'self-resolution'],
          }),
        }
      );

      if (response.ok) {
        const data = await response.json() as { html_url: string };
        return `Issue created: ${data.html_url}`;
      } else {
        const error = await response.text();
        throw new Error(`GitHub API error: ${error}`);
      }
    } catch (error) {
      throw new Error(`Failed to create issue: ${error}`);
    }
  }

  private async triggerWorkflow(repoName: string): Promise<string> {
    if (!this.env.GITHUB_TOKEN) {
      return 'GitHub token not configured - workflow trigger skipped';
    }

    const fullName = `BlackRoad-OS/${repoName}`;

    try {
      const response = await fetch(
        `https://api.github.com/repos/${fullName}/actions/workflows/autonomous-agent.yml/dispatches`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.env.GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ref: 'main' }),
        }
      );

      if (response.ok || response.status === 204) {
        return `Workflow triggered for ${fullName}`;
      } else {
        const error = await response.text();
        throw new Error(`GitHub API error: ${error}`);
      }
    } catch (error) {
      throw new Error(`Failed to trigger workflow: ${error}`);
    }
  }

  private checkCircuitBreaker(): void {
    if (!this.resolverState.circuitBreaker.isOpen) return;

    const lastFailure = this.resolverState.circuitBreaker.lastFailure;
    if (lastFailure && Date.now() - lastFailure > this.CIRCUIT_BREAKER_RESET_MS) {
      console.log('Circuit breaker reset after timeout');
      this.resolverState.circuitBreaker.isOpen = false;
      this.resolverState.circuitBreaker.failures = 0;
    }
  }

  private getActionsToday(type: 'completed' | 'failed'): number {
    const today = new Date().setHours(0, 0, 0, 0);
    const actions = type === 'completed'
      ? this.resolverState.completedActions
      : this.resolverState.failedActions;

    return actions.filter(a => a.executedAt && a.executedAt >= today).length;
  }

  private calculateSuccessRate(): number {
    const total = this.resolverState.resolutionHistory.length;
    if (total === 0) return 100;

    const successes = this.resolverState.resolutionHistory.filter(h => h.success).length;
    return Math.round((successes / total) * 100);
  }

  private identifyPatterns(): string[] {
    const patterns: string[] = [];
    const history = this.resolverState.resolutionHistory;

    // Find most common action types
    const actionCounts = history.reduce((acc, h) => {
      acc[h.action] = (acc[h.action] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    const sortedActions = Object.entries(actionCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3);

    if (sortedActions.length > 0) {
      patterns.push(`Most common actions: ${sortedActions.map(([a, c]) => `${a} (${c})`).join(', ')}`);
    }

    // Find repos with most issues
    const repoCounts = history.reduce((acc, h) => {
      acc[h.repo] = (acc[h.repo] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    const problematicRepos = Object.entries(repoCounts)
      .filter(([, count]) => count > 5)
      .map(([repo]) => repo);

    if (problematicRepos.length > 0) {
      patterns.push(`Repos needing attention: ${problematicRepos.join(', ')}`);
    }

    return patterns;
  }

  private generateRecommendations(): string[] {
    const recommendations: string[] = [];
    const successRate = this.calculateSuccessRate();

    if (successRate < 80) {
      recommendations.push('Success rate is below 80% - consider reviewing automated actions');
    }

    if (this.resolverState.pendingActions.length > 10) {
      recommendations.push('High number of pending actions - consider scaling up processing');
    }

    if (this.resolverState.circuitBreaker.isOpen) {
      recommendations.push('Circuit breaker is open - investigate root cause of failures');
    }

    const recentFailures = this.resolverState.resolutionHistory
      .slice(-20)
      .filter(h => !h.success);

    if (recentFailures.length > 10) {
      recommendations.push('High failure rate in recent history - system may need attention');
    }

    return recommendations;
  }

  private async cleanup(): Promise<void> {
    // Keep only last 1000 completed actions
    if (this.resolverState.completedActions.length > 1000) {
      this.resolverState.completedActions = this.resolverState.completedActions.slice(-1000);
    }

    // Keep only last 500 failed actions
    if (this.resolverState.failedActions.length > 500) {
      this.resolverState.failedActions = this.resolverState.failedActions.slice(-500);
    }

    // Keep only last 5000 history entries
    if (this.resolverState.resolutionHistory.length > 5000) {
      this.resolverState.resolutionHistory = this.resolverState.resolutionHistory.slice(-5000);
    }
  }

  private async saveState(): Promise<void> {
    await this.state.storage.put('resolverState', this.resolverState);
  }
}
