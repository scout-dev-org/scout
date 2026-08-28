export const IMPROVEMENT_ITEM_TYPE = 'improvement';

/**
 * Types that make up the working backlog. Improvements are change requests
 * outside the fix obligation: they never appear in a status queue.
 */
export const BACKLOG_ITEM_TYPES = ['bug', 'note', 'task'] as const;

export type ItemType = typeof BACKLOG_ITEM_TYPES[number] | typeof IMPROVEMENT_ITEM_TYPE;
