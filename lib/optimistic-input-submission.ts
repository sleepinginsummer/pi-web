export type OptimisticInputSnapshot<TImage> = {
  value: string;
  images: TImage[];
  textAttachment: string | null;
  draftKey: string | null;
};

/** 失败内容放在等待期间的新草稿之前，文字与附件都不能因输入框非空而丢失。 */
export function prependSubmittedInput<TImage>(
  submitted: OptimisticInputSnapshot<TImage>,
  current: OptimisticInputSnapshot<TImage>,
): OptimisticInputSnapshot<TImage> {
  return {
    draftKey: current.draftKey,
    value: [submitted.value, current.value].filter((text) => text.length > 0).join("\n\n"),
    images: [...submitted.images, ...current.images],
    textAttachment: [submitted.textAttachment, current.textAttachment].filter((text) => text != null).join("\n\n") || null,
  };
}

export type SubmissionResult = boolean | void | Promise<boolean | void>;

export type OptimisticInputSubmissionOptions<TImage> = {
  clearInput: (revokeImages?: boolean) => void;
  canRestore: (snapshot: OptimisticInputSnapshot<TImage>) => boolean;
  restore: (snapshot: OptimisticInputSnapshot<TImage>) => void;
  discard: (snapshot: OptimisticInputSnapshot<TImage>) => void;
  releaseImages: (images: TImage[]) => void;
  onError?: (error: unknown) => void;
};

/** 执行一次可回滚输入事务；同步拒绝不会清空，异步失败统一恢复或归档。 */
export async function runOptimisticInputSubmission<TImage>(
  options: OptimisticInputSubmissionOptions<TImage>,
  snapshot: OptimisticInputSnapshot<TImage>,
  submit: () => SubmissionResult,
): Promise<boolean> {
  let accepted: SubmissionResult;
  try {
    accepted = submit();
  } catch (error) {
    options.onError?.(error);
    return false;
  }
  if (accepted === false) return false;

  options.clearInput(false);
  let settled: boolean | void;
  try {
    settled = await accepted;
  } catch (error) {
    options.onError?.(error);
    settled = false;
  }

  if (settled !== false) {
    options.releaseImages(snapshot.images);
    return true;
  }

  if (options.canRestore(snapshot)) options.restore(snapshot);
  else options.discard(snapshot);
  return false;
}
