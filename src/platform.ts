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
import { MqttBridge } from './mqtt.js';
import { RemehaApi, RemehaAuthError, type Dashboard } from './remehaApi.js';

export const PLUGIN_NAME = 'homebridge-remeha-etwist';
export const PLATFORM_NAME = 'RemehaHome';

export interface RemehaConfig extends PlatformConfig {
  email?: string;
  password?: string;
  pollInterval?: number;
  setpointChangeInScheduleMode?: 'temporary' | 'manual';
  exposeProgramSwitches?: boolean;
  cooling?: 'auto' | 'on' | 'off';
  exposeHotWater?: boolean;
  exposeOutdoorTemperature?: boolean;
  exposeWaterPressureAlert?: boolean;
  exposeHolidayMode?: boolean;
  mqtt?: {
    enabled?: boolean;
    host?: string;
    port?: number;
    username?: string;
    password?: string;
    topicPrefix?: string;
    allowControl?: boolean;
  };
}

const ENERGY_INTERVAL_MS = 15 * 60_000;

export class RemehaHomePlatform implements DynamicPlatformPlugin {
  readonly Service: typeof Service;
  readonly Characteristic: typeof Characteristic;
  readonly remeha: RemehaApi;

  private readonly cached = new Map<string, PlatformAccessory>();
  private readonly handlers = new Map<string, ZoneAccessory>();
  private pollTimer?: NodeJS.Timeout;
  private refreshTimer?: NodeJS.Timeout;
  private mqtt?: MqttBridge;
  private lastEnergyPoll = 0;

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

    api.on('didFinishLaunching', () => {
      if (config.mqtt?.enabled && config.mqtt.host) {
        this.mqtt = new MqttBridge(this);
      }
      void this.poll();
    });
    api.on('shutdown', () => {
      clearTimeout(this.pollTimer);
      clearTimeout(this.refreshTimer);
      this.mqtt?.close();
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
      const dashboard = await this.remeha.getDashboard();
      this.sync(dashboard);
      this.mqtt?.publishDashboard(dashboard);
      await this.pollEnergy(dashboard);
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

  /** Energy totals only change slowly in the cloud, so they are fetched less often. Only used for MQTT. */
  private async pollEnergy(dashboard: Dashboard): Promise<void> {
    if (!this.mqtt || Date.now() - this.lastEnergyPoll < ENERGY_INTERVAL_MS) {
      return;
    }
    this.lastEnergyPoll = Date.now();
    for (const [i, appliance] of (dashboard.appliances ?? []).entries()) {
      try {
        this.mqtt.publishEnergy(i, await this.remeha.getEnergyToday(appliance.applianceId));
      } catch (err) {
        this.log.warn(`Energy update failed: ${(err as Error).message}`);
      }
    }
  }

  private sync(dashboard: Dashboard): void {
    const seen = new Set<string>();

    for (const appliance of dashboard.appliances ?? []) {
      for (const zone of appliance.climateZones ?? []) {
        this.upsert(seen, `climate:${zone.climateZoneId}`, zone.name, acc => new ClimateZoneAccessory(this, acc, zone.name))
          .update({ ...zone, activeThermalMode: appliance.activeThermalMode });
      }

      if (this.config.exposeHotWater ?? true) {
        for (const zone of appliance.hotWaterZones ?? []) {
          this.upsert(seen, `dhw:${zone.hotWaterZoneId}`, 'Hot Water', acc => new HotWaterAccessory(this, acc))
            .update(zone);
        }
      }

      const outdoor = this.config.exposeOutdoorTemperature ?? true;
      const pressure = this.config.exposeWaterPressureAlert ?? true;
      const holiday = this.config.exposeHolidayMode ?? true;
      if (outdoor || pressure || holiday) {
        this.upsert(seen, `appliance:${appliance.applianceId}`, 'Boiler',
          acc => new ApplianceAccessory(this, acc, outdoor, pressure, holiday))
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
