import { RCON_HOST, RCON_PORT, RCON_PASSWORD } from "../runtime.js";

/** True when RCON connection settings are present (independent of connectivity). */
export function rconConfigured(): boolean {
  return Boolean(RCON_HOST && RCON_PORT && RCON_PASSWORD);
}
