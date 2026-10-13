import { join } from 'node:path';

import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import { ApplianceAccessory, ClimateZoneAccessory, HotWaterAccessory, type ZoneAccessory } from './accessories.js';
import { RemehaApi, RemehaAuthError, type Dashboard } from './remehaApi.js';

export const PLUGIN_NAME = 'homebridge-remeha-home';
export const PLATFORM_NAME = 'RemehaHome';

export interface RemehaConfig extends PlatformConfig {
  email?: string;
  password?: string;
  pollInterval?: number;
  setpointChangeInScheduleMode?: 'temporary' | 'manual';
  exposeHotWater?: boolean;
  exposeOutdoorTemperature?: boolean;
  exposeWaterPressureAlert?: boolean;
}

export class RemehaHomePlatform implements DynamicPlatformPlugin {
  readonly Service: typeof Service;
  readonly Characteristic: typeof Characteristic;
  readonly remeha: RemehaApi;

  private readonly cached = new Map<string, PlatformAccessory>();
  private readonly handlers = new Map<string, ZoneAccessory>();
  private pollTimer?: NodeJS.Timeout;
  private refreshTimer?: NodeJS.Timeout;

  constructor(
    readonly log: Logging,
    readonly config: RemehaConfig,
    readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.remeha = new RemehaApi(
      config.email ?? '',
      config.password ?? '',
      join(api.user.storagePath(), 'remeha-home-token.json'),
      msg => this.log.debug(msg),
    );

    if (!config.email || !config.password) {
      this.log.error('Email and password are required. Configure the plugin in the Homebridge UI.');
      return;
    }

    api.on('didFinishLaunching', () => void this.poll());
    api.on('shutdown', () => {
      clearTimeout(this.pollTimer);
      clearTimeout(this.refreshTimer);
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cached.set(accessory.UUID, accessory);
  }

  /** Poll soon after a command so HomeKit reflects what the boiler actually did. */
  scheduleRefresh(delayMs = 5_000): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.poll(), delayMs);
  }

  private async poll(): Promise<void> {
    clearTimeout(this.pollTimer);
    try {
      this.sync(await this.remeha.getDashboard());
    } catch (err) {
      if (err instanceof RemehaAuthError) {
        this.log.error(err.message);
      } else {
        this.log.warn(`Update failed: ${(err as Error).message}`);
      }
    }
    const interval = Math.max(30, this.config.pollInterval ?? 60) * 1000;
    this.pollTimer = setTimeout(() => void this.poll(), interval);
  }

  private sync(dashboard: Dashboard): void {
    const seen = new Set<string>();

    for (const appliance of dashboard.appliances ?? []) {
      for (const zone of appliance.climateZones ?? []) {
        this.upsert(seen, `climate:${zone.climateZoneId}`, zone.name, acc => new ClimateZoneAccessory(this, acc))
          .update(zone);
      }

      if (this.config.exposeHotWater ?? true) {
        for (const zone of appliance.hotWaterZones ?? []) {
          this.upsert(seen, `dhw:${zone.hotWaterZoneId}`, 'Hot Water', acc => new HotWaterAccessory(this, acc))
            .update(zone);
        }
      }

      const outdoor = this.config.exposeOutdoorTemperature ?? true;
      const pressure = this.config.exposeWaterPressureAlert ?? true;
      if (outdoor || pressure) {
        this.upsert(seen, `appliance:${appliance.applianceId}`, 'Boiler',
          acc => new ApplianceAccessory(this, acc, outdoor, pressure))
          .update(appliance);
      }
    }

    const stale = [...this.cached.values()].filter(acc => !seen.has(acc.UUID));
    if (stale.length) {
      this.log.info(`Removing ${stale.length} accessory(ies) no longer present`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      for (const acc of stale) {
        this.cached.delete(acc.UUID);
        this.handlers.delete(acc.UUID);
      }
    }
  }

  private upsert<T extends ZoneAccessory>(
    seen: Set<string>,
    key: string,
    name: string,
    create: (acc: PlatformAccessory) => T,
  ): T {
    const uuid = this.api.hap.uuid.generate(key);
    seen.add(uuid);

    const existing = this.handlers.get(uuid);
    if (existing) {
      return existing as T;
    }

    let accessory = this.cached.get(uuid);
    if (!accessory) {
      this.log.info(`Adding ${name}`);
      accessory = new this.api.platformAccessory(name, uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.cached.set(uuid, accessory);
    }

    const handler = create(accessory);
    this.handlers.set(uuid, handler);
    return handler;
  }
}
