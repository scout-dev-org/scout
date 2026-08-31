import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { BACKLOG_ITEM_TYPES, type ItemType } from '../lib/item-types';

/**
 * Open items per project — the same population as the Open queue tab of the
 * section that asks. Callers pass the projects they already loaded and the
 * types their section owns, then refresh through `reload`.
 */
export function useProjectOpenCounts(projectIds: string[], itemTypes: readonly ItemType[] = BACKLOG_ITEM_TYPES) {
  const [openCounts, setOpenCounts] = useState<Record<string, number>>({});
  const key = projectIds.join(',');
  const typesKey = itemTypes.join(',');

  const load = useCallback(async () => {
    if (!key) {
      setOpenCounts({});
      return;
    }

    const types = typesKey.split(',');
    const entries = await Promise.all(key.split(',').map(async (projectId) => {
      try {
        const result = await api<{ counts: Record<string, number> }>('/api/items/count', { projectId, itemTypes: types });
        return [projectId, result.counts.new ?? 0] as const;
      } catch {
        return [projectId, 0] as const;
      }
    }));

    setOpenCounts(Object.fromEntries(entries));
  }, [key, typesKey]);

  useEffect(() => {
    load();
  }, [load]);

  const totalOpen = Object.values(openCounts).reduce((sum, count) => sum + count, 0);

  return { openCounts, totalOpen, reload: load };
}
