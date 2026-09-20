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

/** 统一自定义目录确认流程，确保项目身份先于规范化 cwd 生效。 */
export async function commitCustomProjectSelection(
  candidate: string,
  dependencies: CustomProjectSelectionDependencies,
): Promise<string> {
  const validated = await dependencies.validateProject(candidate);
  dependencies.installValidatedProject(validated);

  const added = await dependencies.addProject(validated.cwd);
  dependencies.selectCwd(added.cwd);
  dependencies.commitSelection(added.cwd);
  return added.cwd;
}
