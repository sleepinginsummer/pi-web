export interface SessionTitleTaskState {
  sessionId: string;
  name: string | undefined;
}

export interface SessionTitleTaskRunRequest {
  sessionId: string;
  target: { filePath: string };
  overwrite: boolean;
}

export interface SessionTitleTaskCoordinatorDependencies {
  normalizePath(filePath: string): string;
  readState(filePath: string): SessionTitleTaskState | null;
  run(request: SessionTitleTaskRunRequest): Promise<string | null>;
}

export type SessionTitleTask = SessionTitleTaskRunRequest & {
  requestedName: string | undefined;
  promise: Promise<string | null>;
};

export type SessionTitleTaskRegistry = Map<string, SessionTitleTask>;

/**
 * 协调同一会话的标题任务。稳定 session id 用于去重，共享 target 用于文件 rename 后迁移。
 */
export class SessionTitleTaskCoordinator {
  constructor(
    private readonly dependencies: SessionTitleTaskCoordinatorDependencies,
    private readonly tasks: SessionTitleTaskRegistry = new Map(),
  ) {}

  submit(filePath: string, overwrite = false): Promise<string | null> {
    const normalizedPath = this.dependencies.normalizePath(filePath);
    const requestedState = this.dependencies.readState(normalizedPath);
    if (!requestedState) return Promise.resolve(null);

    const { sessionId, name: requestedName } = requestedState;
    const existing = this.tasks.get(sessionId);
    if (existing) {
      existing.target.filePath = normalizedPath;
      if (!overwrite) return existing.promise;
      // overwrite 只有名称基线相同时才共享；用户改名后的新请求必须追加 successor。
      if (existing.overwrite && existing.requestedName === requestedName) return existing.promise;

      const queuedTask = this.createTask(sessionId, existing.target, true, requestedName);
      queuedTask.promise = existing.promise
        .catch(() => null)
        .then((predecessorTitle: string | null) => {
          const current = this.dependencies.readState(queuedTask.target.filePath);
          if (
            !current
            || current.sessionId !== sessionId
            || !this.canStartQueuedOverwrite(queuedTask.requestedName, current.name, predecessorTitle)
          ) return null;
          return this.dependencies.run(queuedTask);
        })
        .finally(() => this.deleteIfCurrent(sessionId, queuedTask));
      this.tasks.set(sessionId, queuedTask);
      return queuedTask.promise;
    }

    const task = this.createTask(sessionId, { filePath: normalizedPath }, overwrite, requestedName);
    task.promise = this.dependencies.run(task)
      .finally(() => this.deleteIfCurrent(sessionId, task));
    this.tasks.set(sessionId, task);
    return task.promise;
  }

  migrate(sessionId: string, filePath: string): void {
    const task = this.tasks.get(sessionId);
    if (task) task.target.filePath = this.dependencies.normalizePath(filePath);
  }

  private createTask(
    sessionId: string,
    target: { filePath: string },
    overwrite: boolean,
    requestedName: string | undefined,
  ): SessionTitleTask {
    return { sessionId, target, overwrite, requestedName, promise: Promise.resolve(null) };
  }

  private deleteIfCurrent(sessionId: string, task: SessionTitleTask): void {
    if (this.tasks.get(sessionId) === task) this.tasks.delete(sessionId);
  }

  private canStartQueuedOverwrite(
    requestedName: string | undefined,
    currentName: string | undefined,
    predecessorTitle: string | null,
  ): boolean {
    return currentName === requestedName
      || (predecessorTitle !== null && currentName === predecessorTitle);
  }
}
