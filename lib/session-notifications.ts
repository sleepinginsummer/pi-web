export interface SessionNotificationOptions {
  showWhenActive?: boolean;
}

export interface SessionNotificationIntent {
  title: string;
  body: string;
  sessionId?: string | null;
  showWhenActive?: boolean;
  url: string;
}
