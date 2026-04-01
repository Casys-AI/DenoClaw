export interface BrokerCronJob {
  id: string;
  agentId: string;
  name: string;
  schedule: string;
  prompt: string;
  enabled: boolean;
  lastRun?: string;
  createdAt: string;
}
