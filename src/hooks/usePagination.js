import { useEffect, useMemo, useState } from 'react';

export function usePagination(items, pageSize, resetKey) {
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));

  useEffect(() => setPage(1), [resetKey]);
  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  const pageItems = useMemo(
    () => items.slice((page - 1) * pageSize, page * pageSize),
    [items, page, pageSize],
  );

  return { page, pageCount, pageItems, setPage, total: items.length };
}
