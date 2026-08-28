import { useTranslation } from '../i18n';

const colorMap: Record<string, string> = {
  bug: 'bg-red-100 text-red-800',
  note: 'bg-amber-100 text-amber-800',
  task: 'bg-emerald-100 text-emerald-800',
  improvement: 'bg-violet-100 text-violet-800',
};

export default function ItemTypeBadge({ itemType }: { itemType: string | null | undefined }) {
  const { t } = useTranslation();
  const type = itemType || 'bug';
  const color = colorMap[type] ?? 'bg-gray-100 text-gray-600';
  const label = t(`items.types.${type}`);

  return (
    <span className={`inline-block whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${color}`}>
      {label}
    </span>
  );
}
