export const IMPROVEMENT_ITEM_TYPE = 'improvement';

/**
 * Types that make up the working backlog. Improvements are change requests
 * outside the fix obligation, so they live in their own section instead of
 * sharing the backlog's list.
 */
export const BACKLOG_ITEM_TYPES = ['bug', 'note', 'task'] as const;

export type ItemType = typeof BACKLOG_ITEM_TYPES[number] | typeof IMPROVEMENT_ITEM_TYPE;

/** A section of the item list: the navigation entry owns the type, the tabs own the status. */
export type ItemScope = 'backlog' | 'improvements';

export const SCOPE_ITEM_TYPES: Record<ItemScope, readonly ItemType[]> = {
  backlog: BACKLOG_ITEM_TYPES,
  improvements: [IMPROVEMENT_ITEM_TYPE],
};
