import { createE2EELifecycle } from '$lib/sync/e2ee-lifecycle';
import {
  productionE2EETransitionExecutor,
  type E2EETransitionResult,
  type RuntimeE2EELifecycleResults,
} from '$lib/sync/e2ee-transition-executor';

export type { E2EETransitionResult };

export const e2eeLifecycle = createE2EELifecycle<RuntimeE2EELifecycleResults>(
  productionE2EETransitionExecutor,
);
