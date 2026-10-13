# homebridge-remeha-home

Homebridge plugin for Remeha eTwist thermostats, through the same cloud API the Remeha Home app uses.

> Unofficial. The Remeha Home API is undocumented and may change without notice. Needs an internet connection.
> API details come from [msvisser/remeha_home](https://github.com/msvisser/remeha_home).

## What you get in the Home app

| Accessory | Shows | Controls |
|---|---|---|
| **Thermostat** per climate zone | Room temperature, setpoint, heating on/off | **Auto** = schedule, **Heat** = manual, **Off** = frost protection; changing the temperature while on schedule makes a temporary override (or switches to manual, see config) |
| **Hot Water** thermostat | Comfort setpoint, heating on/off | **Heat** = continuous comfort, **Auto** = schedule, **Off** = eco; temperature sets the comfort setpoint |
| **Boiler › Outdoor Temperature** | Outdoor temperature (boiler sensor, falls back to the cloud weather value) | |
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
      "exposeHotWater": true,
      "exposeOutdoorTemperature": true,
      "exposeWaterPressureAlert": true
    }
  ]
}
```

The OAuth tokens are cached in `remeha-home-token.json` in the Homebridge storage folder, so the plugin doesn't log in again on every restart.

## Troubleshooting

- Run Homebridge with debug logging (`-D`) to see login and token refresh steps.
- `Login rejected`: check the email and password by logging in to the Remeha Home app.
- `Login page did not return a request id or CSRF token`: Remeha probably changed their login flow. Please open an issue.
