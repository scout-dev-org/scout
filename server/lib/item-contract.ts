import type { ItemStatus } from '../db/schema.js';

export const ITEM_EVIDENCE_KINDS = ['handoff', 'verification', 'audit', 'blocker'] as const;
export const ITEM_EVIDENCE_RESULTS = ['pass', 'fail', 'blocked', 'partial'] as const;
export const ITEM_EVIDENCE_LEVELS = [
  'static',
  'typecheck',
  'api_smoke',
  'browser_smoke',
  'browser_acceptance',
  'local_acceptance',
  'staging_acceptance',
  'production_acceptance',
  'user_acceptance',
] as const;
export const ITEM_EVIDENCE_COVERAGES = ['item', 'shared_root_cluster', 'route_sweep', 'audit_sample'] as const;
export const ITEM_EVIDENCE_SOURCES = ['agent', 'human', 'ci', 'deploy', 'audit'] as const;
export const ITEM_EVIDENCE_REQUIRED_FIELDS = ['environment', 'scenario', 'action', 'visibleResult'] as const;

export const UPDATE_ITEM_STATUS_TARGETS = ['in_progress', 'review'] as const;
export const DONE_EVIDENCE_LEVELS = [
  'local_acceptance',
  'staging_acceptance',
  'production_acceptance',
  'user_acceptance',
] as const;

export const VALID_ITEM_STATUS_TRANSITIONS: Record<ItemStatus, readonly ItemStatus[]> = {
  new: ['in_progress', 'cancelled'],
  in_progress: ['review', 'done', 'cancelled'],
  review: ['in_progress', 'done', 'changes_requested', 'cancelled'],
  done: ['new', 'changes_requested', 'verified'],
  changes_requested: ['in_progress', 'cancelled'],
  verified: ['new', 'changes_requested'],
  cancelled: ['new'],
};
