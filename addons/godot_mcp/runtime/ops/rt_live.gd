extends RefCounted
## Runtime methods: live inspection, live changes and opt-in eval (worker: live game).
## See runtime/mcp_runtime.gd for the method contract and helpers (find_node, encode...).

const R := preload("../../core/mcp_result.gd")


static func methods() -> Dictionary:
	return {}
