import { useEffect, useState } from 'react';

/**
 * Hitung mundur dalam detik. Dimulai ulang setiap `resetKey` berubah;
 * berhenti saat `active` false.
 */
export function useCountdown(seconds, { active, resetKey }) {
  const [remaining, setRemaining] = useState(seconds);

  useEffect(() => {
    if (!active) return undefined;
    const deadline = Date.now() + seconds * 1000;
    setRemaining(seconds);
    const id = setInterval(() => {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setRemaining(left);
      if (left === 0) clearInterval(id);
    }, 250);
    return () => clearInterval(id);
  }, [seconds, active, resetKey]);

  return remaining;
}
