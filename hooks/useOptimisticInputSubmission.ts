"use client";

import { useCallback } from "react";
import {
  runOptimisticInputSubmission,
  type OptimisticInputSnapshot,
  type OptimisticInputSubmissionOptions,
  type SubmissionResult,
} from "@/lib/optimistic-input-submission";

export type { OptimisticInputSnapshot } from "@/lib/optimistic-input-submission";

/** 管理输入提交事务，并为组件提供稳定的提交函数。 */
export function useOptimisticInputSubmission<TImage>(
  options: OptimisticInputSubmissionOptions<TImage>,
) {
  const {
    canRestore,
    clearInput,
    discard,
    onError,
    releaseImages,
    restore,
  } = options;

  return useCallback((
    snapshot: OptimisticInputSnapshot<TImage>,
    submit: () => SubmissionResult,
  ) => runOptimisticInputSubmission({
    canRestore,
    clearInput,
    discard,
    onError,
    releaseImages,
    restore,
  }, snapshot, submit), [canRestore, clearInput, discard, onError, releaseImages, restore]);
}
