export function hasNonEmptyRecallItems(result) {
  const candidates = [result];
  if (typeof result === "string") {
    try { candidates.push(JSON.parse(result)); } catch { /* not JSON */ }
  }
  if (result && typeof result === "object") {
    candidates.push(result.output);
    if (Array.isArray(result.content)) {
      candidates.push(...result.content.map((part) => part?.text));
    }
  }

  for (const candidate of candidates) {
    let body = candidate;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { continue; }
    }
    if (body && typeof body === "object" && Array.isArray(body.items) && body.items.length > 0) {
      return true;
    }
  }
  return false;
}
