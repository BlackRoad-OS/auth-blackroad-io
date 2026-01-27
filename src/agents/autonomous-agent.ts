// src/agents/autonomous-agent.ts
// Primary Autonomous Agent - Orchestrates all other agents

import type { Env, AgentState, AgentTask, AgentMetrics } from '../types';

interface WebhookEvent {
  event: string;
  payload: Record<string, unknown>;
}

export class AutonomousAgent implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private agentState: AgentState;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;

    // Initialize agent state
    this.agentState = {
      id: 'autonomous-agent-primary',
      name: 'BlackRoad Autonomous Agent',
      status: 'idle',
      lastHeartbeat: Date.now(),
      tasksProcessed: 0,
      errorsEncountered: 0,
      metrics: {
        uptime: 0,
        avgTaskDuration: 0,
        successRate: 100,
      },
    };

    // Restore state from storage
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<AgentState>('agentState');
      if (stored) {
        this.agentState = { ...stored, status: 'idle', lastHeartbeat: Date.now() };
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

        case '/heartbeat':
          return await this.handleHeartbeat();

        case '/task':
          return await this.handleTask(request);

        case '/webhook':
          return await this.handleWebhook(request);

        case '/orchestrate':
          return await this.handleOrchestrate();

        default:
          return new Response('Not Found', { status: 404 });
      }
    } catch (error) {
      console.error('AutonomousAgent error:', error);
      this.agentState.errorsEncountered++;
      this.agentState.metrics.lastErrorAt = Date.now();
      await this.saveState();

      return new Response(JSON.stringify({ error: String(error) }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  private handleStatus(): Response {
    return new Response(JSON.stringify({
      ...this.agentState,
      uptime: Date.now() - (this.agentState.metrics.uptime || Date.now()),
      health: this.calculateHealth(),
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleHeartbeat(): Promise<Response> {
    this.agentState.lastHeartbeat = Date.now();
    this.agentState.status = 'active';

    // Update uptime metric
    if (!this.agentState.metrics.uptime) {
      this.agentState.metrics.uptime = Date.now();
    }

    // Check other agents and trigger actions if needed
    await this.checkSystemHealth();

    await this.saveState();

    return new Response(JSON.stringify({
      status: 'alive',
      heartbeat: this.agentState.lastHeartbeat,
      health: this.calculateHealth(),
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleTask(request: Request): Promise<Response> {
    const task = await request.json<AgentTask>();

    this.agentState.status = 'active';
    this.agentState.currentTask = task;
    const startTime = Date.now();

    try {
      const result = await this.executeTask(task);

      this.agentState.tasksProcessed++;
      this.agentState.metrics.lastSuccessAt = Date.now();

      // Update average task duration
      const duration = Date.now() - startTime;
      this.agentState.metrics.avgTaskDuration =
        (this.agentState.metrics.avgTaskDuration * (this.agentState.tasksProcessed - 1) + duration) /
        this.agentState.tasksProcessed;

      // Update success rate
      this.agentState.metrics.successRate =
        (this.agentState.tasksProcessed / (this.agentState.tasksProcessed + this.agentState.errorsEncountered)) * 100;

      this.agentState.currentTask = undefined;
      this.agentState.status = 'idle';
      await this.saveState();

      return new Response(JSON.stringify({ success: true, result }), {
        headers: { 'Content-Type': 'application/json' },
      });

    } catch (error) {
      this.agentState.errorsEncountered++;
      this.agentState.metrics.lastErrorAt = Date.now();
      this.agentState.currentTask = undefined;
      this.agentState.status = 'error';
      await this.saveState();

      throw error;
    }
  }

  private async handleWebhook(request: Request): Promise<Response> {
    const webhook = await request.json<WebhookEvent>();

    console.log(`Processing webhook: ${webhook.event}`);

    // Analyze the webhook and determine actions
    const actions = await this.analyzeWebhook(webhook);

    // Queue actions for processing
    for (const action of actions) {
      await this.env.AGENT_TASKS.send(action);
    }

    return new Response(JSON.stringify({
      received: true,
      event: webhook.event,
      actionsQueued: actions.length,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleOrchestrate(): Promise<Response> {
    console.log('Starting orchestration cycle');

    // 1. Check repo monitor status
    const monitorId = this.env.REPO_MONITOR.idFromName('primary');
    const monitor = this.env.REPO_MONITOR.get(monitorId);
    const monitorStatus = await monitor.fetch(new Request('http://internal/status'));
    const monitorData = await monitorStatus.json();

    // 2. Check cohesion checker status
    const cohesionId = this.env.COHESION_CHECKER.idFromName('primary');
    const cohesion = this.env.COHESION_CHECKER.get(cohesionId);
    const cohesionStatus = await cohesion.fetch(new Request('http://internal/status'));
    const cohesionData = await cohesionStatus.json();

    // 3. Check self-resolver status
    const resolverId = this.env.SELF_RESOLVER.idFromName('primary');
    const resolver = this.env.SELF_RESOLVER.get(resolverId);
    const resolverStatus = await resolver.fetch(new Request('http://internal/status'));
    const resolverData = await resolverStatus.json();

    // 4. Make decisions based on status
    const decisions = this.makeOrchestrationDecisions({
      monitor: monitorData,
      cohesion: cohesionData,
      resolver: resolverData,
    });

    // 5. Execute decisions
    for (const decision of decisions) {
      await this.executeDecision(decision);
    }

    return new Response(JSON.stringify({
      orchestrationComplete: true,
      decisions: decisions.length,
      agentStatuses: {
        monitor: monitorData,
        cohesion: cohesionData,
        resolver: resolverData,
      },
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async executeTask(task: AgentTask): Promise<unknown> {
    console.log(`Executing task: ${task.type} (${task.id})`);

    switch (task.type) {
      case 'health_check':
        return await this.performHealthCheck();

      case 'analyze_changes':
        return await this.analyzeChanges(task.payload);

      case 'trigger_workflow':
        return await this.triggerWorkflow(task.payload as { repo: string; workflow: string });

      case 'update_deps':
        return await this.triggerDependencyUpdate(task.payload as { repo: string });

      default:
        console.log(`Delegating task ${task.type} to appropriate agent`);
        return { delegated: true, taskType: task.type };
    }
  }

  private async performHealthCheck(): Promise<{ healthy: boolean; details: Record<string, unknown> }> {
    const checks: Record<string, unknown> = {};

    // Check KV namespaces
    try {
      await this.env.AGENT_STATE.put('health_check', Date.now().toString());
      const value = await this.env.AGENT_STATE.get('health_check');
      checks.kvNamespace = { healthy: !!value };
    } catch {
      checks.kvNamespace = { healthy: false };
    }

    // Check other agents
    const agents = ['REPO_MONITOR', 'COHESION_CHECKER', 'SELF_RESOLVER'] as const;

    for (const agentName of agents) {
      try {
        const namespace = this.env[agentName];
        const id = namespace.idFromName('primary');
        const agent = namespace.get(id);
        const response = await agent.fetch(new Request('http://internal/status'));
        checks[agentName] = { healthy: response.ok };
      } catch {
        checks[agentName] = { healthy: false };
      }
    }

    const allHealthy = Object.values(checks).every((c) => (c as { healthy: boolean }).healthy);

    return { healthy: allHealthy, details: checks };
  }

  private async analyzeChanges(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const event = payload.event as string;
    const data = payload.data as Record<string, unknown>;

    const analysis: Record<string, unknown> = {
      event,
      timestamp: Date.now(),
      needsAction: false,
      actions: [],
    };

    // Analyze based on event type
    if (event === 'push') {
      const commits = (data.commits as Array<{ message: string; modified: string[] }>) || [];

      // Check for significant changes
      const hasWorkflowChanges = commits.some((c) =>
        c.modified?.some((f: string) => f.includes('.github/workflows'))
      );

      const hasPackageChanges = commits.some((c) =>
        c.modified?.some((f: string) => f.includes('package.json'))
      );

      if (hasWorkflowChanges || hasPackageChanges) {
        analysis.needsAction = true;
        (analysis.actions as string[]).push('cohesion_check');
      }
    }

    if (event === 'workflow_run') {
      const conclusion = (data.workflow_run as Record<string, unknown>)?.conclusion;
      if (conclusion === 'failure') {
        analysis.needsAction = true;
        (analysis.actions as string[]).push('self_resolve');
      }
    }

    return analysis;
  }

  private async triggerWorkflow(params: { repo: string; workflow: string }): Promise<{ triggered: boolean }> {
    const { repo, workflow } = params;

    if (!this.env.GITHUB_TOKEN) {
      console.log('GitHub token not configured, skipping workflow trigger');
      return { triggered: false };
    }

    try {
      const response = await fetch(
        `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.env.GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          body: JSON.stringify({ ref: 'main' }),
        }
      );

      return { triggered: response.ok };
    } catch (error) {
      console.error('Failed to trigger workflow:', error);
      return { triggered: false };
    }
  }

  private async triggerDependencyUpdate(params: { repo: string }): Promise<{ triggered: boolean }> {
    return this.triggerWorkflow({
      repo: params.repo,
      workflow: 'dependabot-auto.yml',
    });
  }

  private async analyzeWebhook(webhook: WebhookEvent): Promise<AgentTask[]> {
    const tasks: AgentTask[] = [];

    switch (webhook.event) {
      case 'push':
        tasks.push({
          id: crypto.randomUUID(),
          type: 'cohesion_check',
          priority: 'medium',
          payload: { trigger: 'push', data: webhook.payload },
          createdAt: Date.now(),
          retryCount: 0,
          maxRetries: 3,
          status: 'pending',
        });
        break;

      case 'pull_request':
        if ((webhook.payload as { action: string }).action === 'opened') {
          tasks.push({
            id: crypto.randomUUID(),
            type: 'analyze_changes',
            priority: 'high',
            payload: webhook.payload,
            createdAt: Date.now(),
            retryCount: 0,
            maxRetries: 3,
            status: 'pending',
          });
        }
        break;

      case 'workflow_run':
        if ((webhook.payload as { workflow_run: { conclusion: string } }).workflow_run?.conclusion === 'failure') {
          tasks.push({
            id: crypto.randomUUID(),
            type: 'self_resolve',
            priority: 'critical',
            payload: webhook.payload,
            createdAt: Date.now(),
            retryCount: 0,
            maxRetries: 5,
            status: 'pending',
          });
        }
        break;
    }

    return tasks;
  }

  private async checkSystemHealth(): Promise<void> {
    const healthCheck = await this.performHealthCheck();

    if (!healthCheck.healthy) {
      console.warn('System health check failed:', healthCheck.details);

      // Trigger self-resolution
      const resolverId = this.env.SELF_RESOLVER.idFromName('primary');
      const resolver = this.env.SELF_RESOLVER.get(resolverId);

      await resolver.fetch(new Request('http://internal/system-unhealthy', {
        method: 'POST',
        body: JSON.stringify(healthCheck),
      }));
    }
  }

  private makeOrchestrationDecisions(statuses: Record<string, unknown>): Array<{
    agent: string;
    action: string;
    params: Record<string, unknown>;
  }> {
    const decisions: Array<{ agent: string; action: string; params: Record<string, unknown> }> = [];

    // Check if any agent is in error state
    for (const [agent, status] of Object.entries(statuses)) {
      if ((status as { status: string }).status === 'error') {
        decisions.push({
          agent: 'SELF_RESOLVER',
          action: 'recover_agent',
          params: { targetAgent: agent },
        });
      }
    }

    return decisions;
  }

  private async executeDecision(decision: {
    agent: string;
    action: string;
    params: Record<string, unknown>;
  }): Promise<void> {
    console.log(`Executing decision: ${decision.action} on ${decision.agent}`);

    const namespace = this.env[decision.agent as keyof Env] as DurableObjectNamespace;
    if (!namespace) return;

    const id = namespace.idFromName('primary');
    const agent = namespace.get(id);

    await agent.fetch(new Request(`http://internal/${decision.action}`, {
      method: 'POST',
      body: JSON.stringify(decision.params),
    }));
  }

  private calculateHealth(): 'excellent' | 'good' | 'degraded' | 'critical' {
    const { successRate, lastErrorAt } = this.agentState.metrics;
    const timeSinceError = lastErrorAt ? Date.now() - lastErrorAt : Infinity;

    if (successRate >= 99 && timeSinceError > 3600000) return 'excellent';
    if (successRate >= 95 && timeSinceError > 1800000) return 'good';
    if (successRate >= 80) return 'degraded';
    return 'critical';
  }

  private async saveState(): Promise<void> {
    await this.state.storage.put('agentState', this.agentState);
  }
}
