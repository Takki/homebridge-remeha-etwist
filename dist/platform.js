import { join } from 'node:path';
import { ApplianceAccessory, ClimateZoneAccessory, HotWaterAccessory } from './accessories.js';
import { RemehaApi, RemehaAuthError } from './remehaApi.js';
export const PLUGIN_NAME = 'homebridge-remeha-home';
export const PLATFORM_NAME = 'RemehaHome';
export class RemehaHomePlatform {
    log;
    config;
    api;
    Service;
    Characteristic;
    remeha;
    cached = new Map();
    handlers = new Map();
    pollTimer;
    refreshTimer;
    constructor(log, config, api) {
        this.log = log;
        this.config = config;
        this.api = api;
        this.Service = api.hap.Service;
        this.Characteristic = api.hap.Characteristic;
        this.remeha = new RemehaApi(config.email ?? '', config.password ?? '', join(api.user.storagePath(), 'remeha-home-token.json'), msg => this.log.debug(msg));
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
    configureAccessory(accessory) {
        this.cached.set(accessory.UUID, accessory);
    }
    /** Poll soon after a command so HomeKit reflects what the boiler actually did. */
    scheduleRefresh(delayMs = 5_000) {
        clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => void this.poll(), delayMs);
    }
    async poll() {
        clearTimeout(this.pollTimer);
        try {
            this.sync(await this.remeha.getDashboard());
        }
        catch (err) {
            if (err instanceof RemehaAuthError) {
                this.log.error(err.message);
            }
            else {
                this.log.warn(`Update failed: ${err.message}`);
            }
        }
        const interval = Math.max(30, this.config.pollInterval ?? 60) * 1000;
        this.pollTimer = setTimeout(() => void this.poll(), interval);
    }
    sync(dashboard) {
        const seen = new Set();
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
            if (outdoor || pressure) {
                this.upsert(seen, `appliance:${appliance.applianceId}`, 'Boiler', acc => new ApplianceAccessory(this, acc, outdoor, pressure))
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
    upsert(seen, key, name, create) {
        const uuid = this.api.hap.uuid.generate(key);
        seen.add(uuid);
        const existing = this.handlers.get(uuid);
        if (existing) {
            return existing;
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
//# sourceMappingURL=platform.js.map