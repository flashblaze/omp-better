// Canonical object guard for untrusted JSON event envelopes; callers validate used fields.
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
