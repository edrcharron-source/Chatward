import { create } from 'zustand';

/** A device that signed in to this account while the app was open. Null when there is nothing to show. */
export interface DeviceAlert {
  deviceId: string;
  createdAt: number;
}

export const useDeviceAlerts = create<{ alert: DeviceAlert | null }>(() => ({ alert: null }));

export function showDeviceAlert(alert: DeviceAlert): void {
  useDeviceAlerts.setState({ alert });
}

export function dismissDeviceAlert(): void {
  useDeviceAlerts.setState({ alert: null });
}
