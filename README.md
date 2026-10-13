# homebridge-remeha-home

[![Buy me a coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-t4kki-FFDD00?logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/t4kki)

Homebridge plugin for Remeha eTwist thermostats, through the same cloud API the Remeha Home app uses.

> Unofficial. The Remeha Home API is undocumented and may change without notice. Needs an internet connection.
> API details come from [msvisser/remeha_home](https://github.com/msvisser/remeha_home).

## What you get in the Home app

| Accessory | Shows | Controls |
|---|---|---|
| **Thermostat** per climate zone | Room temperature, setpoint, heating on/off | **Auto** = schedule, **Heat** = manual, **Off** = frost protection; changing the temperature while on schedule makes a temporary override (or switches to manual, see config) |
| **Program 1 / 2 / 3** switches per zone | Which heating program is active | Turning one on activates that program and puts the zone on schedule (radio buttons: one is always on). Rename them in the Home app, e.g. "Weekday", "Away" |
| **Cooling** (heat pumps) | Shows Cool and "Cooling" when the heat pump cools | The heat pump switches between heating and cooling itself; the API has no call for it, so Heat and Cool both set manual mode |
| **Hot Water** thermostat | Comfort setpoint, heating on/off | **Heat** = continuous comfort, **Auto** = schedule, **Off** = eco; temperature sets the comfort setpoint |
| **Boiler › Outdoor Temperature** | Outdoor temperature (boiler sensor, falls back to the cloud weather value) | |
| **Boiler › Holiday Mode** | Occupancy sensor: *detected* while holiday mode is on (set in the Remeha app; the API can't set it) | |
| **Boiler › Water Pressure** | Leak sensor that trips when the boiler reports low water pressure, so you get a HomeKit notification | |

## Install

Your thermostat must already be set up in the **Remeha Home** app.

From GitHub (no build tools needed, the compiled plugin is in the repository):

```sh
npm install -g https://github.com/Takki/homebridge-remeha-home/archive/refs/heads/main.tar.gz
```

Homebridge running as a LoxBerry plugin uses its own npm folder, and its npm cache may not be writable:

```sh
npm install -g --cache /tmp/npm-cache \
  --prefix /opt/loxberry/data/plugins/homebridge/homebridge_runtime/npm-global \
  https://github.com/Takki/homebridge-remeha-home/archive/refs/heads/main.tar.gz
```

Use the tarball URL, not `git+https://`: a global install from a git URL links to a temporary folder that npm later deletes.

From a local checkout: `npm install && npm run build && npm link`.

Then restart Homebridge and configure **Remeha Home** in the Homebridge UI, or add this to `config.json`:

```json
{
  "platforms": [
    {
      "platform": "RemehaHome",
      "name": "Remeha Home",
      "email": "you@example.com",
      "password": "your-remeha-home-password",
      "pollInterval": 60,
      "setpointChangeInScheduleMode": "temporary",
      "exposeProgramSwitches": true,
      "cooling": "auto",
      "exposeHotWater": true,
      "exposeOutdoorTemperature": true,
      "exposeWaterPressureAlert": true,
      "exposeHolidayMode": true,
      "mqtt": {
        "enabled": true,
        "host": "192.168.0.10",
        "username": "loxberry",
        "password": "secret",
        "topicPrefix": "remeha",
        "allowControl": false
      }
    }
  ]
}
```

The OAuth tokens are cached in `remeha-home-token.json` in the Homebridge storage folder, so the plugin doesn't log in again on every restart.

## MQTT (optional)

Publishes everything to an MQTT broker, e.g. the LoxBerry MQTT Gateway, Home Assistant or Node-RED. Enable it under **MQTT** in the plugin settings. Values are retained and only sent when they change; booleans are `1`/`0`.

| Topic | Values |
|---|---|
| `remeha/status` | `online` / `offline` |
| `remeha/boiler/…` | `online`, `water_pressure`, `water_pressure_ok`, `outdoor_temperature`, `thermal_mode`, `cooling`, `operating_mode`, `error_status`, `holiday` (1/0), `holiday_start`, `holiday_end` |
| `remeha/zone/<name>/…` | `room_temperature`, `setpoint`, `mode` + `mode_code` (0 off, 1 manual, 2 schedule, 3 temporary), `program`, `heating`, `cooling`, `demand`, `schedule_setpoint`, `next_setpoint`, `next_switch_time` |
| `remeha/hot_water/…` | `temperature`, `target_setpoint`, `comfort_setpoint`, `reduced_setpoint`, `mode` + `mode_code` (0 eco, 1 comfort, 2 schedule), `heating`, `status` |
| `remeha/energy/…` | today's kWh: `heating_/hot_water_/cooling_consumed_today`, `…_delivered_today`, `consumed_today`, `delivered_today`, and `cop_today`, `heating_cop_today`, `hot_water_cop_today` (every 15 min) |

`<name>` is the zone name in lowercase with `_` for spaces, e.g. `woonkamer`.

With **Accept commands** enabled (off by default):

| Topic | Payload |
|---|---|
| `remeha/zone/<name>/setpoint/set` | temperature, e.g. `21.5` |
| `remeha/zone/<name>/mode/set` | `schedule`, `manual`, `off` (or `2`, `1`, `0`) |
| `remeha/zone/<name>/program/set` | `1`, `2` or `3` |
| `remeha/hot_water/comfort_setpoint/set` | temperature, e.g. `55` |
| `remeha/hot_water/mode/set` | `comfort`, `schedule`, `eco` (or `1`, `2`, `0`) |

## Support

If this plugin keeps your house warm, you can buy me a coffee ☕

<a href="https://buymeacoffee.com/t4kki"><img src="https://img.buymeacoffee.com/button-api/?text=Buy me a coffee&emoji=☕&slug=t4kki&button_colour=FFDD00&font_colour=000000&font_family=Cookie&outline_colour=000000&coffee_colour=ffffff" alt="Buy me a coffee" height="40"></a>

## Troubleshooting

- Run Homebridge with debug logging (`-D`) to see login and token refresh steps.
- `Login rejected`: check the email and password by logging in to the Remeha Home app.
- `Login page did not return a request id or CSRF token`: Remeha probably changed their login flow. Please open an issue.
