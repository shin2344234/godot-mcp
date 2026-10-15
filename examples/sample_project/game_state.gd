extends Node
## Autoload ("GameState") holding global game data. Kept trivial on purpose: it exists
## so tests can check that projects with autoloads work with the headless runner.

signal score_changed(new_score: int)

var score: int = 0


func add_score(amount: int) -> void:
	score += amount
	score_changed.emit(score)
