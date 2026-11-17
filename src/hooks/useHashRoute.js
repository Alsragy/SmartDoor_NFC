import { useEffect, useState } from 'react';

const readHash = () => window.location.hash.replace(/^#\/?/, '').split('?')[0];

/**
 * Router hash minimal (#/overview, #/doors, ...). Nilai yang tidak dikenal
 * jatuh ke `fallback`, sehingga hash dari URL tidak pernah dipakai mentah.
 */
export function useHashRoute(validRoutes, fallback) {
  const resolve = () => (validRoutes.includes(readHash()) ? readHash() : fallback);
  const [route, setRoute] = useState(resolve);

  useEffect(() => {
    const onChange = () => {
      setRoute(resolve());
      window.scrollTo({ top: 0 });
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return route;
}
