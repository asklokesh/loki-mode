import { useState } from 'react';
import { Monitor, Tablet, Smartphone } from 'lucide-react';

// C25: Device frame selector for preview
// C31: Responsive breakpoint indicator

type DeviceType = 'desktop' | 'tablet' | 'mobile';

interface DeviceConfig {
  id: DeviceType;
  label: string;
  icon: typeof Monitor;
  width: string;        // CSS width for iframe container
  frameWidth: number;    // numeric px value for indicator
  frameClass: string;    // border styling to look like device
}

const devices: DeviceConfig[] = [
  {
    id: 'desktop',
    label: 'Desktop',
    icon: Monitor,
    width: '100%',
    frameWidth: 1920,
    frameClass: 'device-frame-desktop',
  },
  {
    id: 'tablet',
    label: 'Tablet',
    icon: Tablet,
    width: '768px',
    frameWidth: 768,
    frameClass: 'device-frame-tablet',
  },
  {
    id: 'mobile',
    label: 'Mobile',
    icon: Smartphone,
    width: '375px',
    frameWidth: 375,
    frameClass: 'device-frame-mobile',
  },
];

interface DeviceFrameSelectorProps {
  selectedDevice: DeviceType;
  onDeviceChange: (device: DeviceType) => void;
  containerWidth?: number; // actual rendered width in px
}

export function DeviceFrameSelector({ selectedDevice, onDeviceChange, containerWidth }: DeviceFrameSelectorProps) {
  return (
    <div className="flex items-center gap-1">
      {devices.map(device => {
        const Icon = device.icon;
        const isActive = selectedDevice === device.id;
        return (
          <button
            key={device.id}
            onClick={() => onDeviceChange(device.id)}
            title={`${device.label} (${device.frameWidth}px)`}
            className={`p-1.5 rounded transition-colors ${
              isActive
                ? 'bg-primary/10 text-primary'
                : 'text-muted hover:text-ink hover:bg-hover'
            }`}
          >
            <Icon size={14} />
          </button>
        );
      })}

      {/* C31: Responsive breakpoint indicator */}
      {containerWidth != null && containerWidth > 0 && (
        <span className="text-[10px] font-mono text-muted ml-1 tabular-nums">
          {containerWidth}px
        </span>
      )}
    </div>
  );
}

export function useDeviceFrame() {
  const [device, setDevice] = useState<DeviceType>('desktop');

  const config = devices.find(d => d.id === device) || devices[0];

  return {
    device,
    setDevice,
    iframeWidth: config.width,
    frameClass: config.frameClass,
    frameWidth: config.frameWidth,
  };
}

export type { DeviceType };
