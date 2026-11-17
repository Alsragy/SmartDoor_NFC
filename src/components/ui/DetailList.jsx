/** Daftar pasangan label-nilai untuk isi dialog/kartu. */
export function DetailList({ items }) {
  return (
    <dl className="grid gap-2 text-sm">
      {items.map(([label, value]) => (
        <div key={label} className="flex items-center justify-between gap-4">
          <dt className="text-slate-400">{label}</dt>
          <dd className="text-right font-mono text-label-mono-md text-slate-100">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
