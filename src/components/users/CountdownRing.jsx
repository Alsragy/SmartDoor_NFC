import { cx } from '../../utils/cx';

const RADIUS = 52;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** Cincin hitung mundur untuk jendela tunggu reader NFC. */
export function CountdownRing({ remaining, total }) {
  const ratio = remaining / total;
  const urgent = remaining <= 10;

  return (
    <div className="relative size-36" role="timer" aria-live="off" aria-label={`Sisa waktu ${remaining} detik`}>
      <svg viewBox="0 0 120 120" className="size-full -rotate-90">
        <circle cx="60" cy="60" r={RADIUS} fill="none" strokeWidth="6" className="stroke-white/8" />
        <circle
          cx="60"
          cy="60"
          r={RADIUS}
          fill="none"
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - ratio)}
          className={cx('transition-[stroke-dashoffset] duration-300', urgent ? 'stroke-tertiary' : 'stroke-secondary')}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={cx('font-mono text-4xl font-bold', urgent ? 'text-tertiary-light' : 'text-white')}>{remaining}</span>
        <span className="font-mono text-[11px] text-slate-400">detik</span>
      </div>
    </div>
  );
}
