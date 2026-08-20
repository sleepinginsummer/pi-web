export interface ShadowSessionControl {
  scopeKey: string;
  sessionId: string | null;
  enabled: boolean;
  pending: boolean;
  available: boolean;
  onToggle: () => void;
}
