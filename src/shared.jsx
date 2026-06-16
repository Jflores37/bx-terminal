import React from 'react';

// Shared bits used by App + the lazy-loaded views (keeps them importable across chunks).
export const SCAN_META = {
  daily:   { tvInterval: 'D', label: 'DAILY'   },
  weekly:  { tvInterval: 'W', label: 'WEEKLY'  },
  monthly: { tvInterval: 'M', label: 'MONTHLY' },
};

export function Stat({ label, value, valueClass = 'text-zinc-100' }) {
  return (
    <div className="px-3 py-2 border-r border-zinc-800 last:border-r-0">
      <div className="text-[9px] text-zinc-600 tracking-[0.2em]">{label}</div>
      <div className={`text-[12px] font-bold mt-0.5 ${valueClass}`}>{value}</div>
    </div>
  );
}
