extends Node2D
## Root script of the sample main scene.


func _on_timer_timeout() -> void:
	GameState.add_score(1)
