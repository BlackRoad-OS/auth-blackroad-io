import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'miniflare',
    environmentOptions: {
      modules: true,
      scriptPath: './src/worker.ts',
      durableObjects: {
        AUTONOMOUS_AGENT: 'AutonomousAgent',
        REPO_MONITOR: 'RepoMonitor',
        COHESION_CHECKER: 'CohesionChecker',
        SELF_RESOLVER: 'SelfResolver',
      },
    },
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
});
