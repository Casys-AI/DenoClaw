export function isNavItemActive(currentPath: string, href: string): boolean {
  const normalizedHref = href.startsWith("/") ? href : `/${href}`;

  return currentPath === normalizedHref ||
    currentPath.startsWith(`${normalizedHref}/`) ||
    (normalizedHref === "/overview" && currentPath === "/");
}

export function buildA2AFilterHref(
  statusFilter: string,
  searchQuery: string,
): string {
  const params = new URLSearchParams();
  params.set("status", statusFilter);

  const trimmedQuery = searchQuery.trim();
  if (trimmedQuery) {
    params.set("q", trimmedQuery);
  }

  return `?${params.toString()}`;
}

export function parseApiErrorText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "Request failed";

  try {
    const parsed = JSON.parse(trimmed);
    return extractApiErrorMessage(parsed) ?? trimmed;
  } catch {
    return trimmed;
  }
}

function extractApiErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;

  const record = payload as Record<string, unknown>;
  if (typeof record.message === "string" && record.message.trim()) {
    return record.message.trim();
  }

  const error = record.error;
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }

  if (!error || typeof error !== "object") return null;

  const errorRecord = error as Record<string, unknown>;
  if (typeof errorRecord.message === "string" && errorRecord.message.trim()) {
    return errorRecord.message.trim();
  }

  const context = errorRecord.context;
  if (context && typeof context === "object") {
    const contextMessage = (context as Record<string, unknown>).message;
    if (
      typeof contextMessage === "string" && contextMessage.trim()
    ) {
      return contextMessage.trim();
    }
  }

  if (typeof errorRecord.recovery === "string" && errorRecord.recovery.trim()) {
    return errorRecord.recovery.trim();
  }

  if (typeof errorRecord.code === "string" && errorRecord.code.trim()) {
    return errorRecord.code.trim();
  }

  return null;
}
