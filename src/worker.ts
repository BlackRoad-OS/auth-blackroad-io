// src/worker.ts
// BlackRoad Auth - Cloudflare Workers Entry Point
// Autonomous Agent System for Cross-Repo Cohesiveness

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env, AgentTask } from './types';

// Import Durable Objects
export { AutonomousAgent } from './agents/autonomous-agent';
export { RepoMonitor } from './agents/repo-monitor';
export { CohesionChecker } from './agents/cohesion-checker';
export { SelfResolver } from './agents/self-resolver';

const app = new Hono<{ Bindings: Env }>();

// CORS for API access
app.use('/*', cors({
  origin: ['https://blackroad.io', 'https://*.blackroad.io', 'http://localhost:3000'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Agent-Key'],
}));

// Health check endpoint
app.get('/', (c) => {
  return c.json({
    service: 'auth-blackroad-io',
    status: 'operational',
    version: '1.0.0',
    brand: 'BlackRoad OS',
    timestamp: new Date().toISOString(),
  });
});

// Agent status dashboard
app.get('/api/agents/status', async (c) => {
  const env = c.env;

  // Get status from each Durable Object
  const agentId = env.AUTONOMOUS_AGENT.idFromName('primary');
  const agent = env.AUTONOMOUS_AGENT.get(agentId);
  const agentStatus = await agent.fetch(new Request('http://internal/status'));

  const monitorId = env.REPO_MONITOR.idFromName('primary');
  const monitor = env.REPO_MONITOR.get(monitorId);
  const monitorStatus = await monitor.fetch(new Request('http://internal/status'));

  const cohesionId = env.COHESION_CHECKER.idFromName('primary');
  const cohesion = env.COHESION_CHECKER.get(cohesionId);
  const cohesionStatus = await cohesion.fetch(new Request('http://internal/status'));

  const resolverId = env.SELF_RESOLVER.idFromName('primary');
  const resolver = env.SELF_RESOLVER.get(resolverId);
  const resolverStatus = await resolver.fetch(new Request('http://internal/status'));

  return c.json({
    agents: {
      autonomous: await agentStatus.json(),
      monitor: await monitorStatus.json(),
      cohesion: await cohesionStatus.json(),
      resolver: await resolverStatus.json(),
    },
    environment: env.ENVIRONMENT,
    autoResolveEnabled: env.AUTO_RESOLVE_ENABLED === 'true',
  });
});

// Trigger manual repo scan
app.post('/api/agents/scan', async (c) => {
  const env = c.env;
  const body = await c.req.json<{ repos?: string[] }>();

  const monitorId = env.REPO_MONITOR.idFromName('primary');
  const monitor = env.REPO_MONITOR.get(monitorId);

  const response = await monitor.fetch(new Request('http://internal/scan', {
    method: 'POST',
    body: JSON.stringify({ repos: body.repos }),
  }));

  return c.json(await response.json());
});

// Get cohesion report
app.get('/api/cohesion/report', async (c) => {
  const env = c.env;

  const cohesionId = env.COHESION_CHECKER.idFromName('primary');
  const cohesion = env.COHESION_CHECKER.get(cohesionId);

  const response = await cohesion.fetch(new Request('http://internal/report'));
  return c.json(await response.json());
});

// Trigger cohesion check
app.post('/api/cohesion/check', async (c) => {
  const env = c.env;

  const cohesionId = env.COHESION_CHECKER.idFromName('primary');
  const cohesion = env.COHESION_CHECKER.get(cohesionId);

  const response = await cohesion.fetch(new Request('http://internal/check', {
    method: 'POST',
  }));

  return c.json(await response.json());
});

// Get resolution history
app.get('/api/resolution/history', async (c) => {
  const env = c.env;

  const resolverId = env.SELF_RESOLVER.idFromName('primary');
  const resolver = env.SELF_RESOLVER.get(resolverId);

  const response = await resolver.fetch(new Request('http://internal/history'));
  return c.json(await response.json());
});

// Trigger self-resolution
app.post('/api/resolution/trigger', async (c) => {
  const env = c.env;
  const body = await c.req.json<{ issueId: string }>();

  if (!body.issueId) {
    return c.json({ error: 'issueId is required' }, 400);
  }

  const resolverId = env.SELF_RESOLVER.idFromName('primary');
  const resolver = env.SELF_RESOLVER.get(resolverId);

  const response = await resolver.fetch(new Request('http://internal/resolve', {
    method: 'POST',
    body: JSON.stringify({ issueId: body.issueId }),
  }));

  return c.json(await response.json());
});

// Queue a task manually
app.post('/api/tasks/queue', async (c) => {
  const env = c.env;
  const task = await c.req.json<Partial<AgentTask>>();

  const fullTask: AgentTask = {
    id: crypto.randomUUID(),
    type: task.type || 'health_check',
    priority: task.priority || 'medium',
    payload: task.payload || {},
    createdAt: Date.now(),
    retryCount: 0,
    maxRetries: 3,
    status: 'pending',
  };

  await env.AGENT_TASKS.send(fullTask);

  return c.json({ queued: true, taskId: fullTask.id });
});

// Webhook endpoint for GitHub events
app.post('/api/webhooks/github', async (c) => {
  const env = c.env;
  const event = c.req.header('X-GitHub-Event');
  const payload = await c.req.json();

  console.log(`Received GitHub webhook: ${event}`);

  // Queue task based on event type
  const task: AgentTask = {
    id: crypto.randomUUID(),
    type: 'analyze_changes',
    priority: event === 'push' ? 'high' : 'medium',
    payload: { event, data: payload },
    createdAt: Date.now(),
    retryCount: 0,
    maxRetries: 3,
    status: 'pending',
  };

  await env.AGENT_TASKS.send(task);

  // Also notify the autonomous agent
  const agentId = env.AUTONOMOUS_AGENT.idFromName('primary');
  const agent = env.AUTONOMOUS_AGENT.get(agentId);

  await agent.fetch(new Request('http://internal/webhook', {
    method: 'POST',
    body: JSON.stringify({ event, payload }),
  }));

  return c.json({ received: true, taskId: task.id });
});

// Main export
export default {
  fetch: app.fetch,

  // Scheduled handler for cron triggers
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    console.log(`Scheduled trigger: ${event.cron}`);

    const cronHandlers: Record<string, () => Promise<void>> = {
      '*/15 * * * *': async () => {
        // Every 15 min - Agent heartbeat
        const agentId = env.AUTONOMOUS_AGENT.idFromName('primary');
        const agent = env.AUTONOMOUS_AGENT.get(agentId);
        await agent.fetch(new Request('http://internal/heartbeat', { method: 'POST' }));
      },

      '0 * * * *': async () => {
        // Every hour - Full repo sync
        const monitorId = env.REPO_MONITOR.idFromName('primary');
        const monitor = env.REPO_MONITOR.get(monitorId);
        await monitor.fetch(new Request('http://internal/sync', { method: 'POST' }));
      },

      '0 */6 * * *': async () => {
        // Every 6 hours - Deep cohesion analysis
        const cohesionId = env.COHESION_CHECKER.idFromName('primary');
        const cohesion = env.COHESION_CHECKER.get(cohesionId);
        await cohesion.fetch(new Request('http://internal/deep-check', { method: 'POST' }));
      },

      '0 0 * * *': async () => {
        // Daily - Self-resolution review
        const resolverId = env.SELF_RESOLVER.idFromName('primary');
        const resolver = env.SELF_RESOLVER.get(resolverId);
        await resolver.fetch(new Request('http://internal/daily-review', { method: 'POST' }));
      },
    };

    const handler = cronHandlers[event.cron];
    if (handler) {
      ctx.waitUntil(handler());
    }

    // Log to analytics
    env.AGENT_ANALYTICS.writeDataPoint({
      blobs: [event.cron, 'scheduled_trigger'],
      doubles: [Date.now()],
      indexes: ['cron_execution'],
    });
  },

  // Queue consumer for async task processing
  async queue(batch: MessageBatch<AgentTask>, env: Env, ctx: ExecutionContext) {
    console.log(`Processing ${batch.messages.length} tasks from queue`);

    for (const message of batch.messages) {
      const task = message.body;

      try {
        // Route task to appropriate agent
        let agentNamespace: DurableObjectNamespace;

        switch (task.type) {
          case 'repo_scan':
          case 'sync_repos':
            agentNamespace = env.REPO_MONITOR;
            break;
          case 'cohesion_check':
            agentNamespace = env.COHESION_CHECKER;
            break;
          case 'self_resolve':
          case 'rollback':
            agentNamespace = env.SELF_RESOLVER;
            break;
          default:
            agentNamespace = env.AUTONOMOUS_AGENT;
        }

        const agentId = agentNamespace.idFromName('primary');
        const agent = agentNamespace.get(agentId);

        const response = await agent.fetch(new Request('http://internal/task', {
          method: 'POST',
          body: JSON.stringify(task),
        }));

        if (!response.ok) {
          throw new Error(`Task failed: ${await response.text()}`);
        }

        message.ack();

        // Log success
        env.AGENT_ANALYTICS.writeDataPoint({
          blobs: [task.type, 'task_completed'],
          doubles: [Date.now(), 1],
          indexes: ['task_processing'],
        });

      } catch (error) {
        console.error(`Task ${task.id} failed:`, error);

        if (task.retryCount < task.maxRetries) {
          // Retry the task
          message.retry();
        } else {
          // Max retries exceeded - trigger self-resolution
          const resolverId = env.SELF_RESOLVER.idFromName('primary');
          const resolver = env.SELF_RESOLVER.get(resolverId);

          await resolver.fetch(new Request('http://internal/task-failed', {
            method: 'POST',
            body: JSON.stringify({ task, error: String(error) }),
          }));

          message.ack(); // Don't retry anymore
        }

        // Log failure
        env.AGENT_ANALYTICS.writeDataPoint({
          blobs: [task.type, 'task_failed', String(error)],
          doubles: [Date.now(), 0],
          indexes: ['task_processing'],
        });
      }
    }
  },
};
