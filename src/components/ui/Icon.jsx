import { cx } from '../../utils/cx';

/** Ikon Material Symbols Outlined (dekoratif, disembunyikan dari screen reader). */
export function Icon({ name, size = 20, filled = false, className }) {
  return (
    <span
      aria-hidden="true"
      className={cx('icon-glyph shrink-0 select-none', className)}
      style={{ fontSize: size, fontVariationSettings: `'FILL' ${filled ? 1 : 0}, 'wght' 400` }}
    >
      {name}
    </span>
  );
}
