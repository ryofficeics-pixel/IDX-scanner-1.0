import { createHash, timingSafeEqual } from 'node:crypto';

function digest(value) {
  return createHash('sha256').update(String(value), 'utf8').digest();
}

export function bearerToken(header) {
  const match = String(header || '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

export function tokenMatches(header, expectedToken) {
  const supplied = bearerToken(header);
  if (!supplied || !expectedToken) return false;
  return timingSafeEqual(digest(supplied), digest(expectedToken));
}
