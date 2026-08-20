import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { AppError } from '../common/errors';
import {
  _resetAutomationLockForTest,
  acquireAutomationLock,
  currentAutomationRun,
  releaseAutomationLock,
} from './automation.lock';

beforeEach(() => _resetAutomationLockForTest());

describe('automation apply lock', () => {
  it('lets a single apply acquire and release', () => {
    acquireAutomationLock({ trigger: 'manual' });
    assert.equal(currentAutomationRun()?.trigger, 'manual');
    releaseAutomationLock();
    assert.equal(currentAutomationRun(), null);
  });

  it('rejects a second apply while one is running', () => {
    acquireAutomationLock({ trigger: 'manual', requestId: 'req-1' });
    let code = 'NO_THROW';
    try {
      acquireAutomationLock({ trigger: 'webhook' });
    } catch (error) {
      code = error instanceof AppError ? error.code : 'OTHER';
    }
    assert.equal(code, 'AUTOMATION_ALREADY_RUNNING');
  });

  it('allows a new apply once the previous released', () => {
    acquireAutomationLock({ trigger: 'manual' });
    releaseAutomationLock();
    // Must not throw.
    acquireAutomationLock({ trigger: 'webhook' });
    assert.equal(currentAutomationRun()?.trigger, 'webhook');
  });
});
