@tool
extends RefCounted
## Step 3 editor methods: editor viewport screenshots (worker: view/perf).
## Descriptor contract: see core/methods.gd (kinds scene_mutation / scene_read / project,
## optional "editor_only": true).

const R := preload("../core/mcp_result.gd")


static func methods() -> Dictionary:
	return {}
