/**
 * One requestId per incoming request, generated once at the top of the
 * middleware pipeline and threaded through middleware -> routes ->
 * services, per docs/monitoring-and-alerting.md's structured logging
 * convention. Also the value returned to a client on an INTERNAL_ERROR
 * response, so a support conversation can reference one concrete ID.
 */
export function generateRequestId(): string {
  return crypto.randomUUID();
}
