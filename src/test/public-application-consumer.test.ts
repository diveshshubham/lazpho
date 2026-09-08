import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createLazphoApplication,
  startLazphoDashboard,
  type LazphoApplication,
  type LazphoApplicationOptions,
  type LazphoDashboard,
  type LazphoScenario
} from '../application.js';

test('public application integration types support central configuration and an opt-in dashboard', async () => {
  const configuration: LazphoApplicationOptions = {
    controllers: { database: { limit: 2, maxQueueSize: 8 } },
    adaptiveControllers: {
      databasePolicy: { controller: 'database', minLimit: 1, maxLimit: 4, targetP95Ms: 100, maxErrorRate: 0.1, mode: 'observe' }
    },
    routeControllers: { '/users/:id': ['database'] }
  };
  const application: LazphoApplication = createLazphoApplication(configuration);
  const scenarios: readonly LazphoScenario[] = [{
    name: 'read-users',
    description: 'Safe read-only consumer scenario',
    run: async ({ application: app, signal }) => {
      await app.run('database', () => undefined, { signal });
      return { outcomes: { success: 1 } };
    }
  }];
  const dashboard: LazphoDashboard = await startLazphoDashboard({ application, port: 0, scenarios });

  assert.equal(dashboard.state().scenarios[0]?.name, 'read-users');
  assert.equal(application.evaluateAdaptive().databasePolicy?.mode, 'observe');
  await dashboard.close();
  await application.close();
});
