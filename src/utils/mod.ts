/**
 * BACKWARD-COMPAT SHIM — sera supprimé en Phase 9.
 * Ré-exporte depuis src/shared/.
 */
export { log } from "../shared/log.ts";
export {
  ensureDir,
  fileExists,
  formatDate,
  generateId,
  getConfigPath,
  getCronJobsPath,
  getHomeDir,
  getMemoryDir,
  getSkillsDir,
  truncate,
} from "../shared/helpers.ts";
export {
  ChannelError,
  ConfigError,
  DenoClawError,
  ProviderError,
  ToolError,
} from "../shared/errors.ts";
