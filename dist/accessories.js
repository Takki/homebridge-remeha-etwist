const SETPOINT_DEBOUNCE_MS = 1_500;
class BaseAccessory {
    platform;
    accessory;
    data;
    constructor(platform, accessory, model) {
        this.platform = platform;
        this.accessory = accessory;
        const { Service, Characteristic } = platform;
        accessory.getService(Service.AccessoryInformation)
            .setCharacteristic(Characteristic.Manufacturer, 'Remeha')
            .setCharacteristic(Characteristic.Model, model)
            .setCharacteristic(Characteristic.SerialNumber, accessory.UUID.slice(0, 8));
    }
    /** Runs a command, logs failures and triggers a refresh either way. */
    async run(description, action) {
        this.platform.log.info(`${this.accessory.displayName}: ${description}`);
        try {
            await action();
        }
        catch (err) {
            this.platform.log.error(`${this.accessory.displayName}: ${description} failed: ${err.message}`);
        }
        this.platform.scheduleRefresh();
    }
    requireData() {
        if (!this.data) {
            throw new this.platform.api.hap.HapStatusError(-70402 /* this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE */);
        }
        return this.data;
    }
}
/** Updates a target temperature and narrows its range to what the zone allows, without HAP range warnings. */
function setTarget(characteristic, value, min, max) {
    characteristic.updateValue(value).setProps({ minValue: Math.min(min, value), maxValue: Math.max(max, value) });
}
/** The API sometimes returns booleans as "True"/"False" strings. */
function isTrue(value) {
    return value === true || value === 'True' || value === 'true';
}
/** Debounces rapid setpoint changes from the Home app slider into one API call. */
class Debouncer {
    timer;
    call(fn) {
        clearTimeout(this.timer);
        this.timer = setTimeout(fn, SETPOINT_DEBOUNCE_MS);
    }
}
const PROGRAMS = [1, 2, 3];
/**
 * A climate zone as a thermostat: Auto = schedule, Heat/Cool = manual, Off = frost protection.
 * The heat pump decides between heating and cooling itself; the API has no call to switch it,
 * so Heat and Cool both mean manual and the shown mode follows the appliance's thermal mode.
 * Optionally adds one switch per heating program (1-3), which behave like radio buttons.
 */
export class ClimateZoneAccessory extends BaseAccessory {
    service;
    programSwitches = new Map();
    debounce = new Debouncer();
    constructor(platform, accessory, zoneName) {
        super(platform, accessory, 'eTwist climate zone');
        const { Service, Characteristic } = platform;
        const State = Characteristic.TargetHeatingCoolingState;
        this.service = accessory.getService(Service.Thermostat) ?? accessory.addService(Service.Thermostat);
        this.service.getCharacteristic(Characteristic.CurrentTemperature).setProps({ minValue: -20, maxValue: 60 });
        this.service.getCharacteristic(Characteristic.TemperatureDisplayUnits).updateValue(Characteristic.TemperatureDisplayUnits.CELSIUS);
        this.service.getCharacteristic(State)
            .setProps({ validValues: this.modes() })
            .onSet(value => this.setMode(value));
        this.service.getCharacteristic(Characteristic.TargetTemperature)
            .setProps({ minValue: 5, maxValue: 30, minStep: 0.5 })
            .onSet(value => this.setTemperature(value));
        const wantSwitches = platform.config.exposeProgramSwitches ?? true;
        for (const program of PROGRAMS) {
            const subtype = `program-${program}`;
            const existing = accessory.getServiceById(Service.Switch, subtype);
            if (!wantSwitches) {
                if (existing) {
                    accessory.removeService(existing);
                }
                continue;
            }
            const name = `${zoneName} Program ${program}`;
            const service = existing ?? accessory.addService(Service.Switch, name, subtype);
            if (!existing) {
                service.addOptionalCharacteristic(Characteristic.ConfiguredName);
                service.setCharacteristic(Characteristic.ConfiguredName, name);
            }
            service.getCharacteristic(Characteristic.On).onSet(value => this.setProgram(program, value));
            this.programSwitches.set(program, service);
        }
    }
    update(zone) {
        this.data = zone;
        const { Characteristic } = this.platform;
        const State = Characteristic.TargetHeatingCoolingState;
        const Current = Characteristic.CurrentHeatingCoolingState;
        // Remember once cooling has been seen: the capability flag is not always reliable.
        if (zone.activeThermalMode === 'Cooling' || isTrue(zone.capabilityCooling)) {
            this.accessory.context.canCool = true;
        }
        this.service.getCharacteristic(State).setProps({ validValues: this.modes() });
        setTarget(this.service.getCharacteristic(Characteristic.TargetTemperature), zone.setPoint, zone.setPointMin, zone.setPointMax);
        this.service.updateCharacteristic(Characteristic.CurrentTemperature, zone.roomTemperature ?? zone.setPoint);
        this.service.updateCharacteristic(Current, ['ProducingHeat', 'RequestingHeat'].includes(zone.activeComfortDemand) ? Current.HEAT
            : ['ProducingCold', 'RequestingCold'].includes(zone.activeComfortDemand) ? Current.COOL
                : Current.OFF);
        const manual = this.canCool() && zone.activeThermalMode === 'Cooling' ? State.COOL : State.HEAT;
        const mode = zone.zoneMode === 'Manual' ? manual
            : zone.zoneMode === 'FrostProtection' ? State.OFF
                : State.AUTO;
        this.service.updateCharacteristic(State, mode);
        for (const [program, service] of this.programSwitches) {
            service.updateCharacteristic(Characteristic.On, zone.activeHeatingClimateTimeProgramNumber === program);
        }
    }
    canCool() {
        const setting = this.platform.config.cooling ?? 'auto';
        return setting === 'on' || (setting === 'auto' && this.accessory.context.canCool === true);
    }
    modes() {
        const State = this.platform.Characteristic.TargetHeatingCoolingState;
        return this.canCool() ? [State.OFF, State.HEAT, State.COOL, State.AUTO] : [State.OFF, State.HEAT, State.AUTO];
    }
    async setProgram(program, on) {
        const zone = this.requireData();
        if (!on) {
            // Exactly one program is always active; turning the active one off is undone.
            setTimeout(() => this.programSwitches.get(program)
                ?.updateCharacteristic(this.platform.Characteristic.On, zone.activeHeatingClimateTimeProgramNumber === program), 500);
            return;
        }
        zone.activeHeatingClimateTimeProgramNumber = program;
        zone.zoneMode = 'Scheduling';
        for (const [other, service] of this.programSwitches) {
            if (other !== program) {
                service.updateCharacteristic(this.platform.Characteristic.On, false);
            }
        }
        this.service.updateCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState, this.platform.Characteristic.TargetHeatingCoolingState.AUTO);
        await this.run(`heating program ${program}`, async () => {
            await this.platform.remeha.activateHeatingProgram(zone.climateZoneId, program);
            await this.platform.remeha.setClimateSchedule(zone.climateZoneId, program);
        });
    }
    async setMode(value) {
        const zone = this.requireData();
        const State = this.platform.Characteristic.TargetHeatingCoolingState;
        const id = zone.climateZoneId;
        if (value === State.AUTO) {
            zone.zoneMode = 'Scheduling';
            await this.run('schedule mode', () => this.platform.remeha.setClimateSchedule(id, zone.activeHeatingClimateTimeProgramNumber));
        }
        else if (value === State.HEAT || value === State.COOL) {
            const wanted = value === State.COOL ? 'Cooling' : 'Heating';
            if (this.canCool() && zone.activeThermalMode && zone.activeThermalMode !== wanted) {
                this.platform.log.warn(`${this.accessory.displayName}: the heat pump is in ${zone.activeThermalMode.toLowerCase()} mode. `
                    + 'It switches between heating and cooling by itself; this can only set manual mode.');
            }
            zone.zoneMode = 'Manual';
            await this.run(`manual mode at ${zone.setPoint}°C`, () => this.platform.remeha.setClimateManual(id, zone.setPoint));
        }
        else if (value === State.OFF) {
            zone.zoneMode = 'FrostProtection';
            await this.run('frost protection (off)', () => this.platform.remeha.setClimateOff(id));
        }
    }
    setTemperature(value) {
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
export class HotWaterAccessory extends BaseAccessory {
    service;
    debounce = new Debouncer();
    constructor(platform, accessory) {
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
            .onSet(value => this.setTemperature(value));
    }
    update(zone) {
        this.data = zone;
        const { Characteristic } = this.platform;
        const State = Characteristic.TargetHeatingCoolingState;
        setTarget(this.service.getCharacteristic(Characteristic.TargetTemperature), zone.comfortSetPoint, zone.setPointMin, zone.setPointMax);
        this.service.updateCharacteristic(Characteristic.CurrentTemperature, zone.dhwTemperature ?? zone.targetSetpoint);
        this.service.updateCharacteristic(Characteristic.CurrentHeatingCoolingState, zone.dhwStatus === 'ProducingHeat'
            ? Characteristic.CurrentHeatingCoolingState.HEAT
            : Characteristic.CurrentHeatingCoolingState.OFF);
        const mode = zone.dhwZoneMode === 'ContinuousComfort' ? State.HEAT
            : zone.dhwZoneMode === 'Schedule' ? State.AUTO
                : State.OFF;
        this.service.updateCharacteristic(State, mode);
    }
    async setMode(value) {
        const zone = this.requireData();
        const State = this.platform.Characteristic.TargetHeatingCoolingState;
        const id = zone.hotWaterZoneId;
        if (value === State.AUTO) {
            zone.dhwZoneMode = 'Schedule';
            await this.run('hot water schedule', () => this.platform.remeha.setHotWaterSchedule(id));
        }
        else if (value === State.HEAT) {
            zone.dhwZoneMode = 'ContinuousComfort';
            await this.run('hot water comfort', () => this.platform.remeha.setHotWaterComfort(id));
        }
        else if (value === State.OFF) {
            zone.dhwZoneMode = 'Off';
            await this.run('hot water eco', () => this.platform.remeha.setHotWaterEco(id));
        }
    }
    setTemperature(value) {
        const zone = this.requireData();
        zone.comfortSetPoint = value;
        this.debounce.call(() => void this.run(`hot water comfort setpoint ${value}°C`, () => this.platform.remeha.setHotWaterComfortSetpoint(zone.hotWaterZoneId, value)));
    }
}
/** Boiler-level sensors: outdoor temperature and a leak sensor that trips on low water pressure. */
export class ApplianceAccessory extends BaseAccessory {
    outdoor;
    pressure;
    constructor(platform, accessory, outdoor, pressure) {
        super(platform, accessory, 'Boiler');
        const { Service, Characteristic } = platform;
        this.outdoor = this.ensure(Service.TemperatureSensor, outdoor, 'Outdoor Temperature');
        this.outdoor?.getCharacteristic(Characteristic.CurrentTemperature).setProps({ minValue: -50, maxValue: 60 });
        this.pressure = this.ensure(Service.LeakSensor, pressure, 'Water Pressure');
    }
    update(appliance) {
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
    ensure(type, wanted, name) {
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
//# sourceMappingURL=accessories.js.map