/** Desired-vs-registered model diff. */

export function diffModels(current: string[], desired: string[]): { added: string[]; removed: string[] } {
	const have = new Set(current);
	const want = new Set(desired);
	const added = desired.filter((id) => !have.has(id));
	const removed = current.filter((id) => !want.has(id));
	return { added, removed };
}
