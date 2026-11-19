function copyTextFallback(text: string): void {
  const activeElement = document.activeElement;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  try {
    document.body.appendChild(textarea);
    textarea.select();
    if (!document.execCommand("copy")) throw new Error("Copy command was rejected");
  } finally {
    textarea.remove();
    if (activeElement?.isConnected && "focus" in activeElement && typeof activeElement.focus === "function") {
      activeElement.focus({ preventScroll: true });
    }
  }
}

export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // 移动端长按可能已失去 Clipboard API 的瞬时授权，继续尝试兼容路径。
    }
  }
  copyTextFallback(text);
}
