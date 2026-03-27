/**
 * Multi-instance configuration.
 * Parses DENOCLAW_BROKER_URLS env var.
 * Format: "name:url,name:url" e.g. "casys:http://broker1.com,alpha:http://broker2.com"
 * Fallback: DENOCLAW_BROKER_URL as single instance "local".
 */

export interface Instance {
  name: string;
  url: string;
}

let _instances: Instance[] | null = null;

export function getInstances(): Instance[] {
  if (_instances) return _instances;

  const multi = Deno.env.get("DENOCLAW_BROKER_URLS");
  if (multi) {
    _instances = multi.split(",").map((entry) => {
      const [name, ...urlParts] = entry.trim().split(":");
      const url = urlParts.join(":"); // rejoin in case url has ':'
      return { name: name.trim(), url: url.trim() };
    }).filter((i) => i.name && i.url);
  }

  if (!_instances || _instances.length === 0) {
    const single = Deno.env.get("DENOCLAW_BROKER_URL") || "http://localhost:3000";
    _instances = [{ name: "local", url: single }];
  }

  return _instances;
}

export function getInstance(name: string): Instance | undefined {
  return getInstances().find((i) => i.name === name);
}

export function getDefaultInstance(): Instance {
  return getInstances()[0];
}
