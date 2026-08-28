export async function writeClipboardText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.setAttribute("readonly", "true");
  textArea.style.position = "fixed";
  textArea.style.top = "-1000px";
  textArea.style.left = "-1000px";
  document.body.append(textArea);
  textArea.select();
  const copied = document.execCommand("copy");
  textArea.remove();

  if (!copied) {
    throw new Error("Clipboard copy was blocked by the browser");
  }
}

export async function readClipboardText(): Promise<string> {
  if (navigator.clipboard?.readText && window.isSecureContext) {
    return await navigator.clipboard.readText();
  }

  throw new Error("Clipboard paste was blocked by the browser");
}
