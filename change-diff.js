import { extractContracts } from './contracts.js';

function lines(value) {
  return value.replace(/\r/g, '').split('\n').map(line => line.trim()).filter(Boolean).slice(0, 500);
}

export function snapshotText(value) {
  return lines(value).join('\n').slice(0, 20_000);
}

export function snapshotSource(value) {
  // Track deployed frontend resources/inline code, not the entire rendered HTML (which includes live price cards).
  const code = value.match(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>|<link\b[^>]*(?:stylesheet|modulepreload)[^>]*>/gi) ?? [];
  return lines(code.join('\n').replace(/></g, '>\n<')).join('\n').slice(0, 20_000);
}

export function hasContractAddress(diff) {
  return extractContracts(diff).length > 0;
}

export function hasLaunchSignal(diff) {
  if (hasContractAddress(diff)) return true;
  // Use phrases/fields, not a bare “token” or “launch”, which are common in market commentary.
  return /\b(contract\s+address|smart\s+contract|contract|mint\s+address|token\s+address|launch\s+token|token\s+launch|launchpad)\b|(?:^|\n)\+\s*CA\s*(?::|$)/i.test(diff);
}

// Compact unified-style diff: common leading/trailing lines are omitted to keep Discord alerts readable.
export function unifiedDiff(before, after, limit = 2_800) {
  const oldLines = lines(before);
  const newLines = lines(after);
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start += 1;
  let oldEnd = oldLines.length - 1;
  let newEnd = newLines.length - 1;
  while (oldEnd >= start && newEnd >= start && oldLines[oldEnd] === newLines[newEnd]) { oldEnd -= 1; newEnd -= 1; }
  const removed = oldLines.slice(start, oldEnd + 1);
  const added = newLines.slice(start, newEnd + 1);
  let output = `--- before\n+++ after\n@@ -${start + 1},${removed.length} +${start + 1},${added.length} @@\n`;
  output += removed.map(line => `-${line}`).join('\n');
  if (removed.length && added.length) output += '\n';
  output += added.map(line => `+${line}`).join('\n');
  return output.length > limit ? `${output.slice(0, limit - 16)}\n…diff truncated` : output;
}
