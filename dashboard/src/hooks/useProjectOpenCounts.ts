import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { BACKLOG_ITEM_TYPES } from '../lib/item-types';

/**
 * Open items per project — the same population as the Open queue tab.
 * Callers pass the projects they already loaded and refresh through `reload`.
 */
export function useProjectOpenCounts(projectIds: string[]) {
  const [openCounts, setOpenCounts] = useState<Record<string, number>>({});
  const key = projectIds.join(',');

  const load = useCallback(async () => {
    if (!key) {
      setOpenCounts({});
      return;
    }

    const entries = await Promise.all(key.split(',').map(async (projectId) => {
      try {
        const result = await api<{ counts: Record<string, number> }>('/api/items/count', { projectId, itemTypes: BACKLOG_ITEM_TYPES });
        return [projectId, result.counts.new ?? 0] as const;
      } catch {
        return [projectId, 0] as const;
      }
    }));

    setOpenCounts(Object.fromEntries(entries));
  }, [key]);

  useEffect(() => {
    load();
  }, [load]);

  const totalOpen = Object.values(openCounts).reduce((sum, count) => sum + count, 0);

  return { openCounts, totalOpen, reload: load };
}
