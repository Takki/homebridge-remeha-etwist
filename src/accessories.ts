import type { Characteristic, CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { RemehaHomePlatform } from './platform.js';
import type { Appliance, ClimateZone, HotWaterZone } from './remehaApi.js';

const SETPOINT_DEBOUNCE_MS = 1_500;

export interface ZoneAccessory {
  update(data: unknown): void;
}

abstract class BaseAccessory<T> implements ZoneAccessory {
  protected data?: T;

  constructor(
    protected readonly platform: RemehaHomePlatform,
    protected readonly accessory: PlatformAccessory,
    model: string,
  ) {
    const { Service, Characteristic } = platform;
    accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Remeha')
      .setCharacteristic(Characteristic.Model, model)
      .setCharacteristic(Characteristic.SerialNumber, accessory.UUID.slice(0, 8));
  }

  abstract update(data: T): void;

  /** Runs a command, logs failures and triggers a refresh either way. */
  protected async run(description: string, action: () => Promise<void>): Promise<void> {
    this.platform.log.info(`${this.accessory.displayName}: ${description}`);
    try {
      await action();
    } catch (err) {
      this.platform.log.error(`${this.accessory.displayName}: ${description} failed: ${(err as Error).message}`);
    }
    this.platform.scheduleRefresh();
  }

  protected requireData(): T {
    if (!this.data) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    return this.data;
  }
}

/** Updates a target temperature and narrows its range to what the zone allows, without HAP range warnings. */
function setTarget(characteristic: Characteristic, value: number, min: number, max: number): void {
  characteristic.updateValue(value).setProps({ minValue: Math.min(min, value), maxValue: Math.max(max, value) });
}

/** Debounces rapid setpoint changes from the Home app slider into one API call. */
class Debouncer {
  private timer?: NodeJS.Timeout;

  call(fn: () => void): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(fn, SETPOINT_DEBOUNCE_MS);
  }
}

export class ClimateZoneAccessory extends BaseAccessory<ClimateZone> {
  private readonly service: Service;
  private readonly debounce = new Debouncer();

  constructor(platform: RemehaHomePlatform, accessory: PlatformAccessory) {
    super(platform, accessory, 'eTwist climate zone');
    const { Service, Characteristic } = platform;
    const State = Characteristic.TargetHeatingCoolingState;

    this.service = accessory.getService(Service.Thermostat) ?? accessory.addService(Service.Thermostat);
    this.service.getCharacteristic(Characteristic.CurrentTemperature).setProps({ minValue: -20, maxValue: 60 });
    this.service.getCharacteristic(Characteristic.TemperatureDisplayUnits).updateValue(Characteristic.TemperatureDisplayUnits.CELSIUS);
    this.service.getCharacteristic(State)
      .setProps({ validValues: [State.OFF, State.HEAT, State.AUTO] })
      .onSet(value => this.setMode(value));
    this.service.getCharacteristic(Characteristic.TargetTemperature)
      .setProps({ minValue: 5, maxValue: 30, minStep: 0.5 })
      .onSet(value => this.setTemperature(value as number));
  }

  update(zone: ClimateZone): void {
    this.data = zone;
    const { Characteristic } = this.platform;
    const State = Characteristic.TargetHeatingCoolingState;

    setTarget(this.service.getCharacteristic(Characteristic.TargetTemperature), zone.setPoint, zone.setPointMin, zone.setPointMax);
    this.service.updateCharacteristic(Characteristic.CurrentTemperature, zone.roomTemperature ?? zone.setPoint);
    this.service.updateCharacteristic(Characteristic.CurrentHeatingCoolingState,
      ['ProducingHeat', 'RequestingHeat'].includes(zone.activeComfortDemand)
        ? Characteristic.CurrentHeatingCoolingState.HEAT
        : Characteristic.CurrentHeatingCoolingState.OFF);

    const mode = zone.zoneMode === 'Manual' ? State.HEAT
      : zone.zoneMode === 'FrostProtection' ? State.OFF
        : State.AUTO;
    this.service.updateCharacteristic(State, mode);
  }

  private async setMode(value: CharacteristicValue): Promise<void> {
    const zone = this.requireData();
    const State = this.platform.Characteristic.TargetHeatingCoolingState;
    const id = zone.climateZoneId;

    if (value === State.AUTO) {
      zone.zoneMode = 'Scheduling';
      await this.run('schedule mode', () => this.platform.remeha.setClimateSchedule(id, zone.activeHeatingClimateTimeProgramNumber));
    } else if (value === State.HEAT) {
      zone.zoneMode = 'Manual';
      await this.run(`manual mode at ${zone.setPoint}°C`, () => this.platform.remeha.setClimateManual(id, zone.setPoint));
    } else if (value === State.OFF) {
      zone.zoneMode = 'FrostProtection';
      await this.run('frost protection (off)', () => this.platform.remeha.setClimateOff(id));
    }
  }

  private setTemperature(value: number): void {
    const zone = this.requireData();
    zone.setPoint = value;
    this.debounce.call(() => {
      const id = zone.climateZoneId;
      const temporary = (zone.zoneMode === 'Scheduling' || zone.zoneMode === 'TemporaryOverride')
        && this.platform.config.setpointChangeInScheduleMode !== 'manual';
      void (temporary
        ? this.run(`temporary override to ${value}°C`, () => this.platform.remeha.setClimateTemporaryOverride(id, value))
        : this.run(`manual setpoint ${value}°C`, () => this.platform.remeha.setClimateManual(id, value)));
    });
  }
}

/**
 * Hot water as a thermostat: Heat = continuous comfort, Auto = schedule, Off = eco.
 * The target temperature is the comfort setpoint.
 */
export class HotWaterAccessory extends BaseAccessory<HotWaterZone> {
  private readonly service: Service;
  private readonly debounce = new Debouncer();

  constructor(platform: RemehaHomePlatform, accessory: PlatformAccessory) {
    super(platform, accessory, 'Domestic hot water');
    const { Service, Characteristic } = platform;
    const State = Characteristic.TargetHeatingCoolingState;

    this.service = accessory.getService(Service.Thermostat) ?? accessory.addService(Service.Thermostat);
    this.service.getCharacteristic(Characteristic.CurrentTemperature).setProps({ minValue: 0, maxValue: 100 });
    this.service.getCharacteristic(Characteristic.TemperatureDisplayUnits).updateValue(Characteristic.TemperatureDisplayUnits.CELSIUS);
    this.service.getCharacteristic(State)
      .setProps({ validValues: [State.OFF, State.HEAT, State.AUTO] })
      .onSet(value => this.setMode(value));
    this.service.getCharacteristic(Characteristic.TargetTemperature)
      .setProps({ minValue: 10, maxValue: 70, minStep: 1 })
      .onSet(value => this.setTemperature(value as number));
  }

  update(zone: HotWaterZone): void {
    this.data = zone;
    const { Characteristic } = this.platform;
    const State = Characteristic.TargetHeatingCoolingState;

    setTarget(this.service.getCharacteristic(Characteristic.TargetTemperature), zone.comfortSetPoint, zone.setPointMin, zone.setPointMax);
    this.service.updateCharacteristic(Characteristic.CurrentTemperature, zone.dhwTemperature ?? zone.targetSetpoint);
    this.service.updateCharacteristic(Characteristic.CurrentHeatingCoolingState,
      zone.dhwStatus === 'ProducingHeat'
        ? Characteristic.CurrentHeatingCoolingState.HEAT
        : Characteristic.CurrentHeatingCoolingState.OFF);

    const mode = zone.dhwZoneMode === 'ContinuousComfort' ? State.HEAT
      : zone.dhwZoneMode === 'Schedule' ? State.AUTO
        : State.OFF;
    this.service.updateCharacteristic(State, mode);
  }

  private async setMode(value: CharacteristicValue): Promise<void> {
    const zone = this.requireData();
    const State = this.platform.Characteristic.TargetHeatingCoolingState;
    const id = zone.hotWaterZoneId;

    if (value === State.AUTO) {
      zone.dhwZoneMode = 'Schedule';
      await this.run('hot water schedule', () => this.platform.remeha.setHotWaterSchedule(id));
    } else if (value === State.HEAT) {
      zone.dhwZoneMode = 'ContinuousComfort';
      await this.run('hot water comfort', () => this.platform.remeha.setHotWaterComfort(id));
    } else if (value === State.OFF) {
      zone.dhwZoneMode = 'Off';
      await this.run('hot water eco', () => this.platform.remeha.setHotWaterEco(id));
    }
  }

  private setTemperature(value: number): void {
    const zone = this.requireData();
    zone.comfortSetPoint = value;
    this.debounce.call(() => void this.run(`hot water comfort setpoint ${value}°C`,
      () => this.platform.remeha.setHotWaterComfortSetpoint(zone.hotWaterZoneId, value)));
  }
}

/** Boiler-level sensors: outdoor temperature and a leak sensor that trips on low water pressure. */
export class ApplianceAccessory extends BaseAccessory<Appliance> {
  private readonly outdoor?: Service;
  private readonly pressure?: Service;

  constructor(platform: RemehaHomePlatform, accessory: PlatformAccessory, outdoor: boolean, pressure: boolean) {
    super(platform, accessory, 'Boiler');
    const { Service, Characteristic } = platform;

    this.outdoor = this.ensure(Service.TemperatureSensor, outdoor, 'Outdoor Temperature');
    this.outdoor?.getCharacteristic(Characteristic.CurrentTemperature).setProps({ minValue: -50, maxValue: 60 });
    this.pressure = this.ensure(Service.LeakSensor, pressure, 'Water Pressure');
  }

  update(appliance: Appliance): void {
    this.data = appliance;
    const { Characteristic } = this.platform;
    const fault = appliance.applianceOnline
      ? Characteristic.StatusFault.NO_FAULT
      : Characteristic.StatusFault.GENERAL_FAULT;

    if (this.outdoor) {
      const info = appliance.outdoorTemperatureInformation;
      const temp = info?.applianceOutdoorTemperature ?? info?.cloudOutdoorTemperature ?? info?.internetOutdoorTemperature;
      if (temp !== null && temp !== undefined) {
        this.outdoor.updateCharacteristic(Characteristic.CurrentTemperature, temp);
      }
      this.outdoor.updateCharacteristic(Characteristic.StatusFault, fault);
    }

    if (this.pressure) {
      this.pressure.updateCharacteristic(Characteristic.LeakDetected, appliance.waterPressureOK
        ? Characteristic.LeakDetected.LEAK_NOT_DETECTED
        : Characteristic.LeakDetected.LEAK_DETECTED);
      this.pressure.updateCharacteristic(Characteristic.StatusFault, fault);
      if (!appliance.waterPressureOK) {
        this.platform.log.warn(`Boiler water pressure is low (${appliance.waterPressure ?? '?'} bar)`);
      }
    }
  }

  /** Adds or removes a service so cached accessories follow config changes. */
  private ensure(type: typeof Service.TemperatureSensor, wanted: boolean, name: string): Service | undefined {
    const existing = this.accessory.getService(type);
    if (!wanted) {
      if (existing) {
        this.accessory.removeService(existing);
      }
      return undefined;
    }
    return existing ?? this.accessory.addService(type, name);
  }
}
