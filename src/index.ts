import type { API } from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME, RemehaHomePlatform } from './platform.js';

export default (api: API) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, RemehaHomePlatform);
};
