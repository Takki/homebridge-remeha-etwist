import mqtt, { type MqttClient } from 'mqtt';

import type { RemehaHomePlatform } from './platform.js';
import type { ClimateZone, Dashboard, EnergyTotals, HotWaterZone } from './remehaApi.js';

// Numeric codes for Loxone, which only takes numbers on virtual inputs.
const ZONE_MODE: Record<string, [string, number]> = {
  FrostProtection: ['off', 0],
  Manual: ['manual', 1],
  Scheduling: ['schedule', 2],
  TemporaryOverride: ['temporary', 3],
};
const DHW_MODE: Record<string, [string, number]> = {
  Off: ['eco', 0],
  AntiFrost: ['eco', 0],
  ContinuousComfort: ['comfort', 1],
  Schedule: ['schedule', 2],
};

/**
 * Publishes Remeha state to MQTT (e.g. the LoxBerry MQTT Gateway) and, when enabled,
 * accepts commands on `<topic>/set`.
 *
 *   <prefix>/status                          online | offline
 *   <prefix>/boiler/...                      water_pressure, outdoor_temperature, cooling, ...
 *   <prefix>/zone/<name>/...                 room_temperature, setpoint, mode, mode_code, program, ...
 *   <prefix>/hot_water/...                   temperature, comfort_setpoint, mode, mode_code, ...
 *   <prefix>/energy/...                      today's kWh and COP
 */
export class MqttBridge {
  private readonly client: MqttClient;
  private readonly prefix: string;
  private readonly published = new Map<string, string>();
  private zones = new Map<string, ClimateZone>();
  private hotWater = new Map<string, HotWaterZone>();

  constructor(private readonly platform: RemehaHomePlatform) {
    const config = platform.config.mqtt!;
    this.prefix = (config.topicPrefix || 'remeha').replace(/\/+$/, '');
    const url = /^[a-z]+:\/\//.test(config.host!) ? config.host! : `mqtt://${config.host}:${config.port ?? 1883}`;

    this.client = mqtt.connect(url, {
      username: config.username || undefined,
      password: config.password || undefined,
      clientId: `homebridge-remeha-${Math.random().toString(16).slice(2, 10)}`,
      reconnectPeriod: 10_000,
      will: { topic: `${this.prefix}/status`, payload: Buffer.from('offline'), retain: true, qos: 1 },
    });

    this.client.on('connect', () => {
      platform.log.info(`MQTT connected to ${url}`);
      this.published.clear();
      this.client.publish(`${this.prefix}/status`, 'online', { retain: true, qos: 1 });
      if (config.allowControl) {
        this.client.subscribe(`${this.prefix}/+/+/set`);
        this.client.subscribe(`${this.prefix}/+/+/+/set`);
      }
    });
    this.client.on('error', err => platform.log.warn(`MQTT: ${err.message}`));
    this.client.on('message', (topic, payload) => void this.handleCommand(topic, payload.toString().trim()));
  }

  close(): void {
    this.client.publish(`${this.prefix}/status`, 'offline', { retain: true, qos: 1 });
    this.client.end();
  }

  publishDashboard(dashboard: Dashboard): void {
    const zones = new Map<string, ClimateZone>();
    const hotWater = new Map<string, HotWaterZone>();

    dashboard.appliances?.forEach((appliance, i) => {
      const boiler = i === 0 ? 'boiler' : `boiler_${i + 1}`;
      const outdoor = appliance.outdoorTemperatureInformation;
      this.publishAll(`${boiler}`, {
        online: appliance.applianceOnline,
        water_pressure: appliance.waterPressure,
        water_pressure_ok: appliance.waterPressureOK,
        outdoor_temperature: outdoor?.applianceOutdoorTemperature ?? outdoor?.cloudOutdoorTemperature
          ?? outdoor?.internetOutdoorTemperature,
        thermal_mode: appliance.activeThermalMode,
        cooling: appliance.activeThermalMode === 'Cooling',
        error_status: appliance.errorStatus,
        operating_mode: appliance.operatingMode,
        holiday: appliance.holidaySchedule?.active === true,
        holiday_start: realTime(appliance.holidaySchedule?.startTime),
        holiday_end: realTime(appliance.holidaySchedule?.endTime),
      });

      for (const zone of appliance.climateZones ?? []) {
        const slug = uniqueSlug(zone.name, zones);
        zones.set(slug, zone);
        const [mode, modeCode] = ZONE_MODE[zone.zoneMode] ?? [zone.zoneMode, -1];
        this.publishAll(`zone/${slug}`, {
          name: zone.name,
          room_temperature: zone.roomTemperature,
          setpoint: zone.setPoint,
          mode,
          mode_code: modeCode,
          program: zone.activeHeatingClimateTimeProgramNumber,
          demand: zone.activeComfortDemand,
          heating: ['ProducingHeat', 'RequestingHeat'].includes(zone.activeComfortDemand),
          cooling: ['ProducingCold', 'RequestingCold'].includes(zone.activeComfortDemand),
          schedule_setpoint: zone.currentScheduleSetPoint,
          next_setpoint: zone.nextSetpoint,
          next_switch_time: zone.nextSwitchTime,
        });
      }

      for (const dhw of appliance.hotWaterZones ?? []) {
        const slug = hotWater.size === 0 ? 'hot_water' : `hot_water_${hotWater.size + 1}`;
        hotWater.set(slug, dhw);
        const [mode, modeCode] = DHW_MODE[dhw.dhwZoneMode] ?? [dhw.dhwZoneMode, -1];
        this.publishAll(slug, {
          temperature: dhw.dhwTemperature,
          target_setpoint: dhw.targetSetpoint,
          comfort_setpoint: dhw.comfortSetPoint,
          reduced_setpoint: dhw.reducedSetpoint,
          mode,
          mode_code: modeCode,
          status: dhw.dhwStatus,
          heating: dhw.dhwStatus === 'ProducingHeat',
          next_switch_time: dhw.nextSwitchTime,
        });
      }
    });

    this.zones = zones;
    this.hotWater = hotWater;
  }

  publishEnergy(index: number, energy: EnergyTotals): void {
    const consumed = energy.heatingEnergyConsumed + energy.hotWaterEnergyConsumed + energy.coolingEnergyConsumed;
    const delivered = energy.heatingEnergyDelivered + energy.hotWaterEnergyDelivered + energy.coolingEnergyDelivered;
    const cop = (d: number, c: number) => (c > 0 && d > 0 ? Math.round((d / c) * 100) / 100 : 0);

    this.publishAll(index === 0 ? 'energy' : `energy_${index + 1}`, {
      heating_consumed_today: round(energy.heatingEnergyConsumed),
      hot_water_consumed_today: round(energy.hotWaterEnergyConsumed),
      cooling_consumed_today: round(energy.coolingEnergyConsumed),
      heating_delivered_today: round(energy.heatingEnergyDelivered),
      hot_water_delivered_today: round(energy.hotWaterEnergyDelivered),
      cooling_delivered_today: round(energy.coolingEnergyDelivered),
      consumed_today: round(consumed),
      delivered_today: round(delivered),
      cop_today: cop(delivered, consumed),
      heating_cop_today: cop(energy.heatingEnergyDelivered, energy.heatingEnergyConsumed),
      hot_water_cop_today: cop(energy.hotWaterEnergyDelivered, energy.hotWaterEnergyConsumed),
    });
  }

  private publishAll(base: string, values: Record<string, string | number | boolean | null | undefined>): void {
    for (const [key, value] of Object.entries(values)) {
      if (value === null || value === undefined) {
        continue;
      }
      const topic = `${this.prefix}/${base}/${key}`;
      const payload = typeof value === 'boolean' ? (value ? '1' : '0') : String(value);
      if (this.published.get(topic) !== payload) {
        this.published.set(topic, payload);
        this.client.publish(topic, payload, { retain: true });
      }
    }
  }

  private async handleCommand(topic: string, payload: string): Promise<void> {
    const parts = topic.slice(this.prefix.length + 1).split('/');
    parts.pop(); // "set"
    const remeha = this.platform.remeha;
    const log = this.platform.log;
    const fail = (msg: string) => log.warn(`MQTT ${topic}: ${msg}`);

    try {
      if (parts[0] === 'zone' && parts.length === 3) {
        const zone = this.zones.get(parts[1]);
        if (!zone) {
          return fail(`unknown zone "${parts[1]}" (known: ${[...this.zones.keys()].join(', ')})`);
        }
        const id = zone.climateZoneId;
        switch (parts[2]) {
          case 'setpoint': {
            const value = Math.round(Number(payload) * 2) / 2;
            if (!(value >= zone.setPointMin && value <= zone.setPointMax)) {
              return fail(`setpoint must be ${zone.setPointMin}-${zone.setPointMax}`);
            }
            const temporary = (zone.zoneMode === 'Scheduling' || zone.zoneMode === 'TemporaryOverride')
              && this.platform.config.setpointChangeInScheduleMode !== 'manual';
            log.info(`MQTT: ${zone.name} ${temporary ? 'temporary override' : 'manual setpoint'} ${value}°C`);
            await (temporary ? remeha.setClimateTemporaryOverride(id, value) : remeha.setClimateManual(id, value));
            break;
          }
          case 'mode': {
            const mode = modeFromPayload(payload, ZONE_MODE);
            log.info(`MQTT: ${zone.name} mode ${mode}`);
            if (mode === 'schedule' || mode === 'temporary') {
              await remeha.setClimateSchedule(id, zone.activeHeatingClimateTimeProgramNumber);
            } else if (mode === 'manual') {
              await remeha.setClimateManual(id, zone.setPoint);
            } else if (mode === 'off') {
              await remeha.setClimateOff(id);
            } else {
              return fail('mode must be schedule|manual|off or 2|1|0');
            }
            break;
          }
          case 'program': {
            const program = Number(payload);
            if (![1, 2, 3].includes(program)) {
              return fail('program must be 1, 2 or 3');
            }
            log.info(`MQTT: ${zone.name} heating program ${program}`);
            await remeha.activateHeatingProgram(id, program);
            await remeha.setClimateSchedule(id, program);
            break;
          }
          default:
            return fail('unknown command');
        }
      } else if (parts[0].startsWith('hot_water') && parts.length === 2) {
        const dhw = this.hotWater.get(parts[0]);
        if (!dhw) {
          return fail('no hot water zone');
        }
        const id = dhw.hotWaterZoneId;
        if (parts[1] === 'comfort_setpoint') {
          const value = Math.round(Number(payload));
          if (!(value >= dhw.setPointMin && value <= dhw.setPointMax)) {
            return fail(`comfort setpoint must be ${dhw.setPointMin}-${dhw.setPointMax}`);
          }
          log.info(`MQTT: hot water comfort setpoint ${value}°C`);
          await remeha.setHotWaterComfortSetpoint(id, value);
        } else if (parts[1] === 'mode') {
          const mode = modeFromPayload(payload, DHW_MODE);
          log.info(`MQTT: hot water mode ${mode}`);
          if (mode === 'comfort') {
            await remeha.setHotWaterComfort(id);
          } else if (mode === 'schedule') {
            await remeha.setHotWaterSchedule(id);
          } else if (mode === 'eco') {
            await remeha.setHotWaterEco(id);
          } else {
            return fail('mode must be comfort|schedule|eco or 1|2|0');
          }
        } else {
          return fail('unknown command');
        }
      } else {
        return fail('unknown command');
      }
    } catch (err) {
      return fail((err as Error).message);
    }
    this.platform.scheduleRefresh();
  }
}

/** Accepts either the mode name or its numeric code. */
function modeFromPayload(payload: string, table: Record<string, [string, number]>): string {
  const value = payload.toLowerCase();
  const byCode = Object.values(table).find(([, code]) => String(code) === value);
  return byCode ? byCode[0] : value;
}

function uniqueSlug(name: string, taken: Map<string, unknown>): string {
  const base = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'zone';
  let slug = base;
  for (let n = 2; taken.has(slug); n++) {
    slug = `${base}_${n}`;
  }
  return slug;
}

/** The API uses 0001-01-01T00:00:00Z for "not set"; publish an empty value instead. */
function realTime(value?: string): string {
  return !value || value.startsWith('0001-') ? '' : value;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
