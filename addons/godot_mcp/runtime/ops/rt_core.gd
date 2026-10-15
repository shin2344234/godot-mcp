extends RefCounted
## Runtime core methods: liveness and basic game facts.

const R := preload("../../core/mcp_result.gd")


static func methods() -> Dictionary:
	return {
		"rt.ping": {"fn": ping},
	}


## Basic facts about the running game; also used by the server as a liveness check.
static func ping(rt: Node, _params: Dictionary) -> Dictionary:
	var tree: SceneTree = rt.get_tree()
	var scene: Node = tree.current_scene
	return R.ok({
		"current_scene": scene.scene_file_path if scene != null else "",
		"paused": tree.paused,
		"time_scale": Engine.time_scale,
		"frames": Engine.get_process_frames(),
		"fps": Engine.get_frames_per_second(),
		"node_count": tree.get_node_count(),
	})
