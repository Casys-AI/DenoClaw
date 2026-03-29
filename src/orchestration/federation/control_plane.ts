export const FEDERATION_CONTROL_METHODS = [
  "federation_link_open",
  "federation_link_ack",
  "federation_catalog_sync",
  "federation_route_probe",
  "federation_link_close",
] as const;

export type FederationControlMethod =
  (typeof FEDERATION_CONTROL_METHODS)[number];

export interface FederationControlEnvelope<Payload = unknown> {
  id: string;
  from: string;
  type: FederationControlMethod;
  payload: Payload;
  timestamp: string;
}

export type FederationControlHandler = (
  envelope: FederationControlEnvelope,
) => Promise<void>;

export type FederationControlHandlerMap = Record<
  FederationControlMethod,
  FederationControlHandler
>;

export function isFederationControlMethod(
  value: string,
): value is FederationControlMethod {
  return FEDERATION_CONTROL_METHODS.includes(value as FederationControlMethod);
}

export function createFederationControlRouter(
  handlers: FederationControlHandlerMap,
): (envelope: FederationControlEnvelope) => Promise<void> {
  return async (envelope) => {
    await handlers[envelope.type](envelope);
  };
}
