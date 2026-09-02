export interface SessionNotificationOptions {
  folderName?: string;
  showWhenActive?: boolean;
}

export interface SessionNotificationIntent {
  title: string;
  body: string;
  folderName?: string;
  sessionId?: string | null;
  showWhenActive?: boolean;
  url: string;
}
