import { LOW_BATTERY_THRESHOLD } from '../../config/constants';
import { cx } from '../../utils/cx';
import { Icon } from '../ui/Icon';

export function batteryTone(percent) {
  if (percent < LOW_BATTERY_THRESHOLD) return 'critical';
  if (percent < 40) return 'warning';
  return 'success';
}

const TONE_CLASS = {
  success: 'text-primary-light',
  warning: 'text-tertiary-light',
  critical: 'text-critical-light',
};

function batteryIcon(percent) {
  if (percent < LOW_BATTERY_THRESHOLD) return 'battery_alert';
  if (percent < 40) return 'battery_3_bar';
  if (percent < 80) return 'battery_5_bar';
  return 'battery_full';
}

export function BatteryIndicator({ percent, voltage }) {
  const tone = batteryTone(percent);
  return (
    <span className={cx('inline-flex items-center gap-1 font-mono text-label-mono-sm', TONE_CLASS[tone])} title={`Baterai UPS ${percent}% (${voltage} V)`}>
      <Icon name={batteryIcon(percent)} size={16} className="rotate-90" />
      UPS {percent}%
    </span>
  );
}
