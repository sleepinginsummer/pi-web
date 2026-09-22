export interface ValidatedProjectIdentity {
  cwd: string;
  projectRoot?: string;
  projectKey?: string;
}

interface CustomProjectSelectionDependencies {
  validateProject: (candidate: string) => Promise<ValidatedProjectIdentity>;
  installValidatedProject: (project: ValidatedProjectIdentity) => void;
  addProject: (cwd: string) => Promise<{ cwd: string }>;
  selectCwd: (cwd: string) => void;
  commitSelection: (cwd: string) => void;
}

/** 目录持久化成功后，以服务端最终 cwd 安装身份并完成选择。 */
export async function commitCustomProjectSelection(
  candidate: string,
  dependencies: CustomProjectSelectionDependencies,
): Promise<string> {
  const validated = await dependencies.validateProject(candidate);
  const added = await dependencies.addProject(validated.cwd);
  dependencies.installValidatedProject({ ...validated, cwd: added.cwd });
  dependencies.selectCwd(added.cwd);
  dependencies.commitSelection(added.cwd);
  return added.cwd;
}
